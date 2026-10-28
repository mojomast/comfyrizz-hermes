import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

import { createTools, MCP_SERVICE, MCP_VERSION } from './tools.mjs';

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
]);
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS.at(-1);
const MAX_HTTP_BODY = 4 * 1024 * 1024;

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, 'id');
}

function toolCallResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(value?.ok === false || value?.refused === true ? { isError: true } : {}),
  };
}

function normalizeProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export function createMcpServer({ tools = createTools() } = {}) {
  async function handleRequest(message) {
    const method = message.method;
    if (typeof method !== 'string' || method === '') {
      return rpcError(message.id, -32600, 'invalid request: method is required');
    }

    if (method === 'initialize') {
      const params = message.params && typeof message.params === 'object' ? message.params : {};
      return rpcResult(message.id, {
        protocolVersion: normalizeProtocolVersion(params.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: MCP_SERVICE,
          version: MCP_VERSION,
        },
        instructions: 'Comfyrizz MCP tools plan, assemble, export and retake a project. Generation is never accepted without an explicit approval id.',
      });
    }

    if (method === 'ping') return rpcResult(message.id, {});

    if (method === 'tools/list') {
      return rpcResult(message.id, { tools: tools.definitions });
    }

    if (method === 'tools/call') {
      const params = message.params && typeof message.params === 'object' ? message.params : null;
      if (!params || typeof params.name !== 'string') {
        return rpcError(message.id, -32602, 'invalid params: tools/call requires a tool name');
      }
      const args = params.arguments ?? {};
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return rpcError(message.id, -32602, 'invalid params: tool arguments must be an object');
      }
      try {
        const value = await tools.call(params.name, args);
        return rpcResult(message.id, toolCallResult(value));
      } catch (error) {
        if (error?.code === 'TOOL_NOT_FOUND') {
          return rpcError(message.id, -32602, error.message);
        }
        if (error?.code === 'INVALID_ARGUMENTS') {
          return rpcResult(message.id, toolCallResult({
            ok: false,
            refused: true,
            stub: false,
            code: error.code,
            message: error.message,
            details: error.details ?? {},
          }));
        }
        return rpcResult(message.id, toolCallResult({
          ok: false,
          stub: false,
          code: 'INTERNAL',
          message: 'the Comfyrizz MCP tool failed',
        }));
      }
    }

    return rpcError(message.id, -32601, `method not found: ${method}`);
  }

  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return rpcError(message?.id ?? null, -32600, 'invalid request');
    }
    if (!hasRequestId(message)) {
      if (message.method === 'notifications/initialized'
        || message.method === 'notifications/cancelled'
        || message.method === 'notifications/progress') {
        return null;
      }
      await handleRequest({ ...message, id: null });
      return null;
    }
    return handleRequest(message);
  }

  return {
    tools,
    handleMessage,
  };
}

export async function runStdioServer({ mcp = createMcpServer(), input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`);
      continue;
    }
    const response = await mcp.handleMessage(message);
    if (response !== null) output.write(`${JSON.stringify(response)}\n`);
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_HTTP_BODY) {
        settle(reject, Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')));
    request.on('error', (error) => settle(reject, error));
  });
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

export function createStreamableHttpServer({
  mcp = createMcpServer(),
  host = '127.0.0.1',
  path = '/mcp',
} = {}) {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('the Comfyrizz MCP HTTP transport binds loopback only');
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`);

    if (url.pathname !== path) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        allow: 'POST, OPTIONS',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type, accept, mcp-session-id',
      });
      response.end();
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST, OPTIONS' });
      response.end();
      return;
    }

    let raw;
    try {
      raw = await readBody(request);
    } catch (error) {
      const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400;
      sendJson(response, status, rpcError(null, -32700, error?.message ?? 'unable to read request body'));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw === '' ? 'null' : raw);
    } catch {
      sendJson(response, 400, rpcError(null, -32700, 'parse error'));
      return;
    }

    if (payload === null || typeof payload !== 'object') {
      sendJson(response, 400, rpcError(null, -32600, 'invalid request'));
      return;
    }

    const batch = Array.isArray(payload);
    const messages = batch ? payload : [payload];
    const responses = [];
    let initialized = false;
    for (const message of messages) {
      if (message?.method === 'initialize') initialized = true;
      const result = await mcp.handleMessage(message);
      if (result !== null) responses.push(result);
    }

    const headers = initialized ? { 'mcp-session-id': randomUUID() } : {};
    if (responses.length === 0) {
      response.writeHead(202, { 'cache-control': 'no-store', ...headers });
      response.end();
      return;
    }
    sendJson(response, 200, batch ? responses : responses[0], headers);
  });

  return server;
}
