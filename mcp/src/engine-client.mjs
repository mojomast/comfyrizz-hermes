const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const DEFAULT_TIMEOUT_MS = 5000;

export class EngineError extends Error {
  constructor(message, { code = 'ENGINE_ERROR', status = null, engineCode = null } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
    this.engineCode = engineCode;
  }
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname).toLowerCase());
}

function resolveBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { baseUrl: null, configError: null };
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { baseUrl: null, configError: 'engine_url_invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { baseUrl: null, configError: 'engine_url_must_be_loopback' };
  }
  if (parsed.username || parsed.password) {
    return { baseUrl: null, configError: 'engine_url_must_not_contain_credentials' };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { baseUrl: null, configError: 'engine_url_must_be_loopback' };
  }
  return { baseUrl: parsed.href.replace(/\/+$/, ''), configError: null };
}

function engineErrorMessage(error) {
  if (!error || typeof error !== 'object') return 'engine request failed';
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return 'engine request failed';
}

/** Hermes forwards COMFYRIZZ_TOKEN. Direct runs may still set COMFYRIZZ_ENGINE_TOKEN. */
export function engineTokenFromEnv(env = process.env) {
  const preferred = env?.COMFYRIZZ_TOKEN;
  if (typeof preferred === 'string' && preferred !== '') return preferred;
  const alias = env?.COMFYRIZZ_ENGINE_TOKEN;
  if (typeof alias === 'string' && alias !== '') return alias;
  return undefined;
}

/**
 * Minimal client for the existing Comfyrizz loopback HTTP server.
 *
 * The client is configured only from a loopback URL. The token is sent in the
 * request header the server already accepts and is never included in a
 * description, result or error message.
 */
export function createEngineClient({
  baseUrl = process.env.COMFYRIZZ_ENGINE_URL,
  token = engineTokenFromEnv(process.env),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const resolved = resolveBaseUrl(baseUrl);
  const configured = resolved.baseUrl !== null;
  const configError = resolved.configError;

  const describe = () => ({
    configured,
    url: configured ? resolved.baseUrl : null,
    configError,
  });

  async function request(path, { method = 'GET', body, headers = {}, timeout = timeoutMs } = {}) {
    if (!configured) {
      throw new EngineError(
        configError === 'engine_url_must_be_loopback'
          ? 'COMFYRIZZ_ENGINE_URL must be an http(s) loopback URL'
          : 'COMFYRIZZ_ENGINE_URL is not configured',
        { code: 'ENGINE_NOT_CONFIGURED' },
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new EngineError('this Node runtime has no fetch implementation', {
        code: 'ENGINE_FETCH_UNAVAILABLE',
      });
    }

    const url = `${resolved.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const requestHeaders = {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(typeof token === 'string' && token !== ''
        ? { 'x-comfyrizz-token': token, authorization: `Bearer ${token}` }
        : {}),
      ...headers,
    };

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(Number.isFinite(timeout) && timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new EngineError(
        timedOut ? 'the Comfyrizz engine did not answer before the timeout' : 'the Comfyrizz engine is unreachable',
        { code: timedOut ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE' },
      );
    }

    const raw = await response.text();
    let parsed = null;
    if (raw !== '') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!response.ok) {
      const message = parsed && typeof parsed === 'object' && typeof parsed.error === 'string'
        ? parsed.error
        : `the Comfyrizz engine responded with HTTP ${response.status}`;
      throw new EngineError(message, {
        code: 'ENGINE_HTTP_ERROR',
        status: response.status,
        engineCode: parsed && typeof parsed === 'object' && typeof parsed.code === 'string'
          ? parsed.code
          : null,
      });
    }

    return parsed;
  }

  return {
    configured,
    configError,
    baseUrl: configured ? resolved.baseUrl : null,
    describe,
    request,
  };
}

export function engineErrorDetails(error) {
  if (!(error instanceof EngineError)) {
    return { code: 'ENGINE_ERROR', message: engineErrorMessage(error), status: null };
  }
  return {
    code: error.code,
    message: error.message,
    status: error.status,
    ...(error.engineCode === null ? {} : { engineCode: error.engineCode }),
  };
}
