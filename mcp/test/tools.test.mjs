import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TOOL_DEFINITIONS, TOOL_NAMES, createTools } from '../src/tools.mjs';
import { createMcpServer, createStreamableHttpServer } from '../src/server.mjs';
import { createEngineClient, engineTokenFromEnv } from '../src/engine-client.mjs';

const EXPECTED_TOOL_NAMES = Object.freeze([
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

function fakeEngine() {
  const requests = [];
  return {
    configured: true,
    baseUrl: 'http://127.0.0.1:4319',
    requests,
    describe() {
      return { configured: true, url: 'http://127.0.0.1:4319', configError: null };
    },
    async request(path, options = {}) {
      requests.push({ path, options });
      if (path === '/api/health') return { ok: true, service: 'comfyrizz-local' };
      if (path.endsWith('/actions/act_1')) {
        return { committed: true, productionId: 'proj_1', revision: 2 };
      }
      return { ok: true, path };
    },
  };
}

test('registers the exact MCP tool names with JSON schemas', () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...EXPECTED_TOOL_NAMES].sort());
  assert.equal(TOOL_DEFINITIONS.length, EXPECTED_TOOL_NAMES.length);
  const names = new Set();
  for (const definition of TOOL_DEFINITIONS) {
    assert.equal(typeof definition.name, 'string');
    assert.equal(typeof definition.description, 'string');
    assert.equal(definition.inputSchema.type, 'object');
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(names.has(definition.name), false);
    names.add(definition.name);
  }
  assert.deepEqual([...names].sort(), [...EXPECTED_TOOL_NAMES].sort());
});

test('status has a stable shape without a live engine', async () => {
  const tools = createTools({ env: {} });
  const status = await tools.call('comfyrizz_status', {});
  assert.equal(status.ok, true);
  assert.equal(status.stub, true);
  assert.equal(status.reason, 'engine_not_configured');
  assert.equal(status.service, 'comfyrizz-mcp');
  assert.equal(typeof status.version, 'string');
  assert.deepEqual(status.transports, ['stdio', 'http']);
  assert.equal(status.engine.configured, false);
  assert.equal(status.engine.reachable, false);
  assert.equal(status.engine.url, null);
  assert.equal(status.engine.health, null);
  assert.deepEqual([...status.tools].sort(), [...EXPECTED_TOOL_NAMES].sort());
});

test('accept_generation refuses without an explicit approval id and never calls the engine', async () => {
  const engine = fakeEngine();
  const tools = createTools({ engine });

  const missing = await tools.call('comfyrizz_accept_generation', {
    projectId: 'proj_1',
    actionId: 'act_1',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.refused, true);
  assert.equal(missing.code, 'APPROVAL_REQUIRED');
  assert.equal(engine.requests.length, 0);

  const blank = await tools.call('comfyrizz_accept_generation', {
    projectId: 'proj_1',
    actionId: 'act_1',
    approvalId: '   ',
  });
  assert.equal(blank.ok, false);
  assert.equal(blank.refused, true);
  assert.equal(blank.code, 'APPROVAL_REQUIRED');
  assert.equal(engine.requests.length, 0);
});

test('every engine-backed tool returns a structured stub without an engine', async () => {
  const tools = createTools({ env: {} });
  const calls = [
    ['comfyrizz_create_project', { brief: 'A short film about a lighthouse' }],
    ['comfyrizz_list_projects', {}],
    ['comfyrizz_plan', { brief: 'A short film about a lighthouse' }],
    ['comfyrizz_get_plan', { projectId: 'proj_1' }],
    ['comfyrizz_get_spend_card', { projectId: 'proj_1' }],
    ['comfyrizz_accept_generation', {
      projectId: 'proj_1',
      actionId: 'act_1',
      planId: 'plan_1',
      planRevision: 0,
      approvalId: 'approval_1',
    }],
    ['comfyrizz_job_status', { jobId: 'job_1' }],
    ['comfyrizz_list_takes', { projectId: 'proj_1' }],
    ['comfyrizz_assemble', { projectId: 'proj_1' }],
    ['comfyrizz_export', { projectId: 'proj_1' }],
    ['comfyrizz_retake', { projectId: 'proj_1', clipId: 'clip_1', change: { text: 'Try again' } }],
  ];

  for (const [name, args] of calls) {
    const result = await tools.call(name, args);
    assert.equal(result.stub, true, `${name} should be a stub`);
    assert.equal(result.ok, false, `${name} should not claim success`);
    assert.equal(result.reason, 'engine_not_configured', `${name} should name the missing engine`);
    assert.equal(typeof result.message, 'string', `${name} should explain the stub`);
  }

  const card = await tools.call('comfyrizz_get_spend_card', { projectId: 'proj_1' });
  assert.equal(card.spend, null);
  assert.equal(card.ceiling, null);
});

test('accept_generation sends the approval to the engine only when present', async () => {
  const engine = fakeEngine();
  const tools = createTools({ engine });
  const result = await tools.call('comfyrizz_accept_generation', {
    projectId: 'proj_1',
    actionId: 'act_1',
    planId: 'plan_1',
    planRevision: 0,
    approvalId: 'approval_1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.stub, false);
  assert.equal(engine.requests.length, 1);
  assert.equal(engine.requests[0].path, '/api/productions/proj_1/actions/act_1');
  assert.equal(engine.requests[0].options.method, 'POST');
  assert.equal(engine.requests[0].options.body.kind, 'action.dispatch');
  assert.equal(engine.requests[0].options.body.payload.actionId, 'act_1');
  assert.equal(engine.requests[0].options.body.payload.approvalId, 'approval_1');
});

test('MCP server handles initialize, tools/list and tools/call', async () => {
  const mcp = createMcpServer({ tools: createTools({ env: {} }) });

  const initialized = await mcp.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  });
  assert.equal(initialized.result.protocolVersion, '2024-11-05');
  assert.equal(initialized.result.serverInfo.name, 'comfyrizz-mcp');
  assert.equal(initialized.result.capabilities.tools.listChanged, false);

  const listed = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOL_NAMES].sort());

  const called = await mcp.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'comfyrizz_status', arguments: {} },
  });
  assert.equal(called.result.structuredContent.service, 'comfyrizz-mcp');
  assert.equal(called.result.isError, undefined);

  const refused = await mcp.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'comfyrizz_accept_generation',
      arguments: { projectId: 'proj_1', actionId: 'act_1' },
    },
  });
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.structuredContent.code, 'APPROVAL_REQUIRED');
});

test('COMFYRIZZ_TOKEN is the engine token Hermes forwards', () => {
  assert.equal(engineTokenFromEnv({ COMFYRIZZ_TOKEN: 'from-hermes', COMFYRIZZ_ENGINE_TOKEN: 'alias' }), 'from-hermes');
  assert.equal(engineTokenFromEnv({ COMFYRIZZ_ENGINE_TOKEN: 'alias' }), 'alias');
  assert.equal(engineTokenFromEnv({ COMFYRIZZ_TOKEN: '' }), undefined);
  assert.equal(engineTokenFromEnv({}), undefined);
});

test('createTools sends COMFYRIZZ_TOKEN to the loopback engine and never echoes it', async () => {
  const previous = globalThis.fetch;
  let authorization;
  globalThis.fetch = async (_url, options) => {
    authorization = options?.headers?.authorization;
    return new Response(JSON.stringify({ ok: true, service: 'comfyrizz-local' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const tools = createTools({
      env: {
        COMFYRIZZ_ENGINE_URL: 'http://127.0.0.1:4319',
        COMFYRIZZ_TOKEN: 'local-test-token',
      },
    });
    const status = await tools.call('comfyrizz_status', {});
    assert.equal(authorization, 'Bearer local-test-token');
    assert.equal(status.stub, false);
    assert.equal(JSON.stringify(status).includes('local-test-token'), false);
    assert.equal(JSON.stringify(tools.engine.describe()).includes('local-test-token'), false);
  } finally {
    globalThis.fetch = previous;
  }
});

test('engine client refuses a non-loopback URL and never exposes the token', () => {
  const client = createEngineClient({
    baseUrl: 'https://example.com',
    token: 'local-test-token',
  });
  assert.equal(client.configured, false);
  assert.equal(client.describe().configError, 'engine_url_must_be_loopback');
  assert.equal(client.describe().url, null);
  assert.equal(JSON.stringify(client.describe()).includes('local-test-token'), false);
});

test('stdio entry answers initialize and ignores the initialized notification', () => {
  const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const input = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  ].join('\n');

  const run = spawnSync(process.execPath, [entry], {
    input: `${input}\n`,
    encoding: 'utf8',
    env: { ...process.env, COMFYRIZZ_ENGINE_URL: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].result.serverInfo.name, 'comfyrizz-mcp');
  assert.equal(lines[0].result.protocolVersion, '2024-11-05');
});

test('optional loopback HTTP transport answers initialize', async (t) => {
  const server = createStreamableHttpServer({
    mcp: createMcpServer({ tools: createTools({ env: {} }) }),
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((response.headers.get('mcp-session-id') ?? '').length > 0, true);
  const body = await response.json();
  assert.equal(body.result.serverInfo.name, 'comfyrizz-mcp');
  assert.equal(body.result.protocolVersion, '2025-06-18');
});

test('CLI entry works with --help and --self-check', () => {
  const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));

  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /comfyrizz-mcp/);
  assert.match(help.stdout, /stdio/);

  const check = spawnSync(process.execPath, [entry, '--self-check'], {
    encoding: 'utf8',
    env: { ...process.env, COMFYRIZZ_ENGINE_URL: '' },
  });
  assert.equal(check.status, 0, check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual([...report.tools].sort(), [...EXPECTED_TOOL_NAMES].sort());
});
