import { randomUUID } from 'node:crypto';

import { createEngineClient, engineErrorDetails, engineTokenFromEnv } from './engine-client.mjs';

export const MCP_SERVICE = 'comfyrizz-mcp';
export const MCP_VERSION = '0.1.0';

export const TOOL_NAMES = Object.freeze([
  'comfyrizz_status',
  'comfyrizz_create_project',
  'comfyrizz_list_projects',
  'comfyrizz_plan',
  'comfyrizz_get_plan',
  'comfyrizz_get_spend_card',
  'comfyrizz_accept_generation',
  'comfyrizz_job_status',
  'comfyrizz_list_takes',
  'comfyrizz_assemble',
  'comfyrizz_export',
  'comfyrizz_retake',
]);

const LEVELS = ['draft', 'balanced', 'director'];
const COMPUTE = ['cpu', 'colab'];

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

const STRING = { type: 'string', minLength: 1 };
const INTEGER = { type: 'integer', minimum: 0 };
const BOOLEAN = { type: 'boolean' };
const OBJECT = { type: 'object' };

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'comfyrizz_status',
    description: 'Report the MCP server, its transports, and whether the local Comfyrizz engine is reachable.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'comfyrizz_create_project',
    description: 'Create a Comfyrizz production on the local engine; generates a brief plan when a brief is supplied. Never spends.',
    inputSchema: objectSchema({
      brief: STRING,
      title: STRING,
    }, ['brief']),
  },
  {
    name: 'comfyrizz_list_projects',
    description: 'List the packages (projects) the local Comfyrizz engine knows about.',
    inputSchema: objectSchema({
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
  },
  {
    name: 'comfyrizz_plan',
    description: 'Plan a brief or propose an Easy plan for a project. Planning does not dispatch paid work.',
    inputSchema: objectSchema({
      projectId: STRING,
      brief: STRING,
      level: { type: 'string', enum: LEVELS },
      compute: { type: 'string', enum: COMPUTE },
      onlyShotIds: { type: 'array', items: STRING },
      revision: INTEGER,
    }),
  },
  {
    name: 'comfyrizz_get_plan',
    description: 'Read the latest proposed plan for a project from the local production journal.',
    inputSchema: objectSchema({
      projectId: STRING,
      planId: STRING,
    }),
  },
  {
    name: 'comfyrizz_get_spend_card',
    description: 'Read the spend cap and budget ledger for a project. Returns no invented spend figure.',
    inputSchema: objectSchema({
      projectId: STRING,
    }, ['projectId']),
  },
  {
    name: 'comfyrizz_accept_generation',
    description: 'Accept and dispatch one plan action. Requires an explicit approval id; refuses without one.',
    inputSchema: objectSchema({
      projectId: STRING,
      actionId: STRING,
      planId: STRING,
      planRevision: INTEGER,
      productionRevision: INTEGER,
      approvalId: STRING,
      approvalToken: STRING,
    }, ['projectId', 'actionId']),
  },
  {
    name: 'comfyrizz_job_status',
    description: 'Read one Comfyrizz run or job record.',
    inputSchema: objectSchema({
      jobId: STRING,
    }, ['jobId']),
  },
  {
    name: 'comfyrizz_list_takes',
    description: 'List the clips and takes for a project, or the takes for one clip.',
    inputSchema: objectSchema({
      projectId: STRING,
      clipId: STRING,
    }, ['projectId']),
  },
  {
    name: 'comfyrizz_assemble',
    description: 'Compile a project timeline on the local CPU. Starts no GPU or Google Colab work.',
    inputSchema: objectSchema({
      projectId: STRING,
      package: OBJECT,
      editor: OBJECT,
      revision: INTEGER,
    }, ['projectId']),
  },
  {
    name: 'comfyrizz_export',
    description: 'Export the portable project bundle for a project through the local engine.',
    inputSchema: objectSchema({
      projectId: STRING,
      variants: OBJECT,
    }, ['projectId']),
  },
  {
    name: 'comfyrizz_retake',
    description: 'Request one clip retake. The request never carries its own spend approval.',
    inputSchema: objectSchema({
      projectId: STRING,
      clipId: STRING,
      change: OBJECT,
      backendId: STRING,
      budgetUnits: { type: 'number', minimum: 0 },
      productionRevision: INTEGER,
    }, ['projectId', 'clipId', 'change']),
  },
]);

export class ToolInputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolInputError';
    this.code = 'INVALID_ARGUMENTS';
    this.details = details;
  }
}

const STUB_MESSAGES = Object.freeze({
  engine_not_configured: 'COMFYRIZZ_ENGINE_URL is not set; start the Comfyrizz server and point this MCP server at its loopback URL.',
  engine_url_rejected: 'COMFYRIZZ_ENGINE_URL must be an http(s) loopback URL with no embedded credentials.',
  engine_unreachable: 'The Comfyrizz engine did not answer on its configured loopback URL.',
  engine_route_not_wired: 'The running Comfyrizz engine does not expose this route yet.',
  engine_error: 'The running Comfyrizz engine refused this request.',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function typeMatches(type, value) {
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateSchema(schema, value, path = '') {
  const at = path === '' ? '(root)' : path;
  if (value === undefined) return;
  if (schema.type && !typeMatches(schema.type, value)) {
    throw new ToolInputError(`${at} must be an ${schema.type}`, { path: at, expected: schema.type });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ToolInputError(`${at} must be one of ${schema.enum.join(', ')}`, { path: at });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ToolInputError(`${at} must be at least ${schema.minLength} character(s)`, { path: at });
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new ToolInputError(`${at} must be at least ${schema.minimum}`, { path: at });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new ToolInputError(`${at} must be at most ${schema.maximum}`, { path: at });
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (value[required] === undefined || value[required] === null) {
        throw new ToolInputError(`${path === '' ? required : `${path}.${required}`} is required`, { path: required });
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (schema.additionalProperties === false && properties[key] === undefined) {
        throw new ToolInputError(`${path === '' ? key : `${path}.${key}`} is not an accepted field`, { path: key });
      }
      if (properties[key]) validateSchema(properties[key], entry, path === '' ? key : `${path}.${key}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => validateSchema(schema.items, entry, `${path}[${index}]`));
  }
}

function definitionFor(name) {
  return TOOL_DEFINITIONS.find((definition) => definition.name === name) ?? null;
}

function engineSnapshot(engine) {
  if (engine && typeof engine.describe === 'function') {
    const described = engine.describe();
    return {
      configured: described?.configured === true,
      url: described?.url ?? null,
      configError: described?.configError ?? null,
    };
  }
  return {
    configured: engine?.configured === true,
    url: engine?.baseUrl ?? null,
    configError: engine?.configError ?? null,
  };
}

function missingEngineReason(engine) {
  const snapshot = engineSnapshot(engine);
  return snapshot.configError !== null ? 'engine_url_rejected' : 'engine_not_configured';
}

function stubResult(engine, reason, extra = {}) {
  const message = STUB_MESSAGES[reason] ?? STUB_MESSAGES.engine_error;
  return {
    ok: false,
    stub: true,
    reason,
    message,
    engine: engineSnapshot(engine),
    ...extra,
  };
}

function stubForError(engine, error, extra = {}) {
  const details = engineErrorDetails(error);
  let reason = 'engine_error';
  if (details.code === 'ENGINE_NOT_CONFIGURED') reason = missingEngineReason(engine);
  else if (details.code === 'ENGINE_UNREACHABLE' || details.code === 'ENGINE_TIMEOUT') reason = 'engine_unreachable';
  else if (details.status === 404 && details.engineCode === null) reason = 'engine_route_not_wired';
  return {
    ...stubResult(engine, reason, extra),
    ...(details.code === 'ENGINE_ERROR' ? {} : { error: details }),
  };
}

function okResult(engine, result, extra = {}) {
  return {
    ok: true,
    stub: false,
    engine: engineSnapshot(engine),
    ...extra,
    result,
  };
}

async function withEngine(engine, work, extra = {}) {
  if (!engine || engine.configured !== true) return stubResult(engine ?? {}, missingEngineReason(engine ?? {}), extra);
  try {
    return okResult(engine, await work(), extra);
  } catch (error) {
    return stubForError(engine, error, extra);
  }
}

function requireText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function dispatchCommandId() {
  return `mcp_${randomUUID().replaceAll('-', '')}`;
}

export function createTools({ engine, env } = {}) {
  const client = engine ?? createEngineClient({
    baseUrl: env?.COMFYRIZZ_ENGINE_URL,
    token: env ? engineTokenFromEnv(env) : undefined,
  });

  const handlers = {
    async comfyrizz_status() {
      const snapshot = engineSnapshot(client);
      if (!client.configured) {
        const reason = missingEngineReason(client);
        return {
          ok: true,
          stub: true,
          reason,
          message: STUB_MESSAGES[reason],
          service: MCP_SERVICE,
          version: MCP_VERSION,
          transports: ['stdio', 'http'],
          engine: { ...snapshot, reachable: false, health: null },
          tools: TOOL_NAMES,
          spend: { configured: false, amount: null },
        };
      }
      try {
        const health = await client.request('/api/health');
        return {
          ok: true,
          stub: false,
          service: MCP_SERVICE,
          version: MCP_VERSION,
          transports: ['stdio', 'http'],
          engine: { ...snapshot, reachable: true, health },
          tools: TOOL_NAMES,
        };
      } catch (error) {
        return {
          ...stubForError(client, error),
          service: MCP_SERVICE,
          version: MCP_VERSION,
          transports: ['stdio', 'http'],
          engine: { ...snapshot, reachable: false, health: null },
          tools: TOOL_NAMES,
          spend: { configured: false, amount: null },
        };
      }
    },

    async comfyrizz_create_project(args) {
      return withEngine(client, async () => {
        const commandId = dispatchCommandId();
        const created = await client.request('/api/productions', {
          method: 'POST',
          body: {
            commandId,
            idempotencyKey: commandId,
            kind: 'production.create',
            expected: { productionRevision: 0 },
            payload: { production: {} },
          },
        });
        let brief = null;
        let briefError = null;
        try {
          brief = await client.request('/api/brief', {
            method: 'POST',
            body: {
              prompt: args.brief,
              ...(args.title === undefined ? {} : { title: args.title }),
            },
          });
        } catch (error) {
          briefError = engineErrorDetails(error);
        }
        return {
          project: created,
          projectId: created?.productionId ?? null,
          brief,
          briefError,
        };
      }, { brief: args.brief });
    },

    async comfyrizz_list_projects(args) {
      return withEngine(client, async () => {
        const query = args.limit === undefined ? '' : `?limit=${args.limit}`;
        const projects = await client.request(`/api/packages${query}`);
        return { projects };
      });
    },

    async comfyrizz_plan(args) {
      if (requireText(args.brief)) {
        return withEngine(client, () => client.request('/api/brief', {
          method: 'POST',
          body: { prompt: args.brief },
        }));
      }
      if (requireText(args.projectId) && args.level !== undefined && args.compute !== undefined) {
        return withEngine(client, () => client.request(`/api/productions/${encodeURIComponent(args.projectId)}/easy-plan`, {
          method: 'POST',
          body: {
            level: args.level,
            compute: args.compute,
            ...(args.onlyShotIds === undefined ? {} : { onlyShotIds: args.onlyShotIds }),
          },
        }));
      }
      if (requireText(args.projectId)) {
        return withEngine(client, () => client.request(`/api/productions/${encodeURIComponent(args.projectId)}`));
      }
      return {
        ok: false,
        refused: true,
        code: 'PLAN_TARGET_REQUIRED',
        message: 'Provide a brief, or a projectId with level and compute, before planning.',
      };
    },

    async comfyrizz_get_plan(args) {
      const id = args.projectId ?? args.planId;
      if (!requireText(id)) {
        return {
          ok: false,
          refused: true,
          code: 'PLAN_TARGET_REQUIRED',
          message: 'Provide projectId or planId.',
        };
      }
      return withEngine(client, async () => {
        const journal = await client.request(`/api/productions/${encodeURIComponent(id)}/events?after=0`);
        const events = Array.isArray(journal?.events) ? journal.events : [];
        const proposals = events.filter((event) => event?.type === 'plan.proposed');
        const latest = proposals.at(-1) ?? null;
        return {
          projectId: id,
          plan: latest?.data ?? null,
          planHash: latest?.data?.planHash ?? null,
          lastSequence: journal?.lastSequence ?? null,
        };
      });
    },

    async comfyrizz_get_spend_card(args) {
      const id = args.projectId;
      return withEngine(client, async () => {
        const card = await client.request(`/api/productions/${encodeURIComponent(id)}/spend-cap`);
        return {
          projectId: id,
          spend: card,
          ceiling: card?.ceiling ?? null,
        };
      }, { spend: null, ceiling: null });
    },

    async comfyrizz_accept_generation(args) {
      const approvalId = requireText(args.approvalId)
        ? args.approvalId
        : (requireText(args.approvalToken) ? args.approvalToken : null);
      if (approvalId === null) {
        return {
          ok: false,
          refused: true,
          stub: false,
          code: 'APPROVAL_REQUIRED',
          message: 'Generation cannot be accepted without an explicit approval id; no spend was authorized.',
        };
      }
      if (args.planId === undefined || args.planRevision === undefined) {
        return {
          ok: false,
          refused: true,
          stub: false,
          code: 'APPROVAL_TARGET_INCOMPLETE',
          message: 'planId and planRevision are required to dispatch an approved plan action; no spend was authorized.',
          approvalId,
        };
      }

      return withEngine(client, async () => {
        const commandId = dispatchCommandId();
        const dispatched = await client.request(
          `/api/productions/${encodeURIComponent(args.projectId)}/actions/${encodeURIComponent(args.actionId)}`,
          {
            method: 'POST',
            body: {
              commandId,
              idempotencyKey: commandId,
              kind: 'action.dispatch',
              expected: { productionRevision: args.productionRevision ?? 0 },
              payload: {
                planId: args.planId,
                planRevision: args.planRevision,
                actionId: args.actionId,
                approvalId,
              },
            },
          },
        );
        return { accepted: true, approvalId, actionId: args.actionId, dispatch: dispatched };
      }, { approvalId, actionId: args.actionId });
    },

    async comfyrizz_job_status(args) {
      return withEngine(client, async () => {
        const job = await client.request(`/api/run/${encodeURIComponent(args.jobId)}`);
        return { jobId: args.jobId, job };
      });
    },

    async comfyrizz_list_takes(args) {
      return withEngine(client, async () => {
        const base = `/api/package/${encodeURIComponent(args.projectId)}/clips`;
        const path = args.clipId === undefined
          ? base
          : `${base}/${encodeURIComponent(args.clipId)}/takes`;
        const takes = await client.request(path);
        return { projectId: args.projectId, clipId: args.clipId ?? null, takes };
      });
    },

    async comfyrizz_assemble(args) {
      return withEngine(client, async () => {
        const timeline = await client.request('/api/compile', {
          method: 'POST',
          body: {
            doc: args.package === undefined && args.editor === undefined
              ? undefined
              : { package: args.package, editor: args.editor },
            packageId: args.projectId,
            revision: args.revision,
          },
        });
        return { projectId: args.projectId, timeline };
      });
    },

    async comfyrizz_export(args) {
      return withEngine(client, async () => {
        const exported = await client.request('/api/export', {
          method: 'POST',
          body: {
            packageId: args.projectId,
            ...(args.variants === undefined ? {} : { variants: args.variants }),
          },
        });
        return { projectId: args.projectId, export: exported };
      });
    },

    async comfyrizz_retake(args) {
      return withEngine(client, async () => {
        const commandId = dispatchCommandId();
        const requested = await client.request(
          `/api/package/${encodeURIComponent(args.projectId)}/clips/${encodeURIComponent(args.clipId)}/regenerate`,
          {
            method: 'POST',
            body: {
              commandId,
              idempotencyKey: commandId,
              change: args.change,
              ...(args.backendId === undefined ? {} : { backendId: args.backendId }),
              ...(args.budgetUnits === undefined ? {} : { budgetUnits: args.budgetUnits }),
              ...(args.productionRevision === undefined
                ? {}
                : { expected: { productionRevision: args.productionRevision } }),
            },
          },
        );
        return {
          projectId: args.projectId,
          clipId: args.clipId,
          spendRequiresApproval: true,
          retake: requested,
        };
      });
    },
  };

  async function call(name, args = {}) {
    const definition = definitionFor(name);
    if (!definition) {
      const error = new Error(`unknown tool ${name}`);
      error.code = 'TOOL_NOT_FOUND';
      throw error;
    }
    if (!isPlainObject(args)) {
      throw new ToolInputError('tool arguments must be an object', { path: '(root)' });
    }
    validateSchema(definition.inputSchema, args);
    return handlers[name](args);
  }

  return {
    engine: client,
    call,
    names: TOOL_NAMES,
    definitions: TOOL_DEFINITIONS,
  };
}
