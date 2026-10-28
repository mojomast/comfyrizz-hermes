#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpServer, createStreamableHttpServer, runStdioServer } from './server.mjs';
import { createTools, MCP_SERVICE, MCP_VERSION, TOOL_NAMES } from './tools.mjs';

const USAGE = `comfyrizz-mcp ${MCP_VERSION}

Usage:
  comfyrizz-mcp                 Run the MCP server over stdio (default)
  comfyrizz-mcp --stdio         Run the MCP server over stdio
  comfyrizz-mcp --http          Run Streamable HTTP on 127.0.0.1
  comfyrizz-mcp --self-check    Print a JSON readiness report and exit
  comfyrizz-mcp --help          Show this help

Environment:
  COMFYRIZZ_ENGINE_URL          Loopback URL of the running Comfyrizz engine
  COMFYRIZZ_TOKEN               Server token for the local Comfyrizz engine
  COMFYRIZZ_ENGINE_TOKEN        Alias for COMFYRIZZ_TOKEN on a direct run
  COMFYRIZZ_MCP_HTTP=1          Enable the optional Streamable HTTP transport
  COMFYRIZZ_MCP_PORT            HTTP port (default 4320, loopback only)

The engine URL and token are never printed. Without an engine every tool returns
a structured stub and generation is refused without an explicit approval id.`;

function parseArgs(argv) {
  const options = {
    mode: process.env.COMFYRIZZ_MCP_HTTP === '1' ? 'http' : 'stdio',
    port: Number(process.env.COMFYRIZZ_MCP_PORT ?? 4320),
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.mode = 'help';
    else if (arg === '--version' || arg === '-v') options.mode = 'version';
    else if (arg === '--self-check') options.mode = 'self-check';
    else if (arg === '--stdio') options.mode = 'stdio';
    else if (arg === '--http') options.mode = 'http';
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--port') options.mode = 'invalid-port';
    else {
      const error = new Error(`unknown argument: ${arg}`);
      error.code = 'UNKNOWN_ARGUMENT';
      throw error;
    }
  }
  if (options.mode === 'http' && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error('the HTTP port must be an integer between 0 and 65535');
  }
  if (options.mode === 'invalid-port') throw new Error('--port requires a value in the --port=<number> form');
  return options;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.mode === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.mode === 'version') {
    process.stdout.write(`${MCP_VERSION}\n`);
    return;
  }

  const tools = createTools();
  if (options.mode === 'self-check') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      service: MCP_SERVICE,
      version: MCP_VERSION,
      transports: ['stdio', 'http'],
      tools: TOOL_NAMES,
      engine: tools.engine.describe(),
    })}\n`);
    return;
  }

  const mcp = createMcpServer({ tools });

  if (options.mode === 'http') {
    const server = createStreamableHttpServer({ mcp, host: '127.0.0.1' });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(options.port, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : options.port;
    process.stdout.write(`comfyrizz-mcp listening on http://127.0.0.1:${port}/mcp\n`);
    const stop = () => server.close(() => { process.exitCode = 0; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }

  await runStdioServer({ mcp });
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`comfyrizz-mcp failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
