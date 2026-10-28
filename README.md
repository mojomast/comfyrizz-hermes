# Comfyrizz Hermes plugin

Chat is the frontend for [Comfyrizz](https://github.com/mojomast/comfyrizz). This repository is a portable [Agent Plugins v1](https://agent-plugins.org/specification) package: one film skill and one local MCP server. Hermes runs the happy path in chat:

> brief → plan → revise → explicit accept → generate (ComfyUI, Comfy API, or Google Colab) → CPU assemble → export → retake

The plugin does not contain the engine, model weights, or a second renderer. The MCP server calls a Comfyrizz engine you already run on loopback. The engine itself lives in the [Comfyrizz](https://github.com/mojomast/comfyrizz) repository.

**Version 0.1.0.** MIT license. Node.js 22 or newer.

## What is in this package

| Path | Purpose |
| --- | --- |
| `plugin.json` | Agent Plugins v1 manifest: name `comfyrizz`, version `0.1.0`, MIT |
| `mcp.json` | One stdio MCP server named `comfyrizz` |
| `skills/comfyrizz-film/SKILL.md` | Skill `comfyrizz-film`: the chat production loop |
| `mcp/` | MCP server (zero npm dependencies). Entry point `mcp/src/index.mjs` |

`mcp.json` starts the server with `node` and `${PLUGIN_ROOT}/mcp/src/index.mjs`, with `${PLUGIN_ROOT}` as the working directory. Every path stays inside this package.

## Install from the catalog

Once this package is listed:

```bash
hermes plugins install comfyrizz
hermes plugins enable comfyrizz
hermes plugins list
```

Restart Hermes so it reloads plugins and MCP servers. Catalog installs check out the exact commit pinned in `plugin-catalog/comfyrizz.yaml`. This package has no self-updater; a newer pin arrives only through a catalog update.

## Install from a path or git

From a checkout of this repository, for testing before a catalog listing:

```bash
hermes plugins install . --no-enable
hermes plugins enable comfyrizz
hermes plugins list
```

A git URL works the same way. Pass the clone, then enable `comfyrizz`. Portable packages stay disabled until you enable them.

In a new Hermes chat, ask for `comfyrizz_status`. A healthy engine reports its status. With no reachable engine the tool returns `stub: true`, which still shows that the plugin loaded. Hermes exposes the skill as `comfyrizz:comfyrizz-film`.

## Prerequisites

- Node.js 22 or newer on `PATH` (`node`). The server is plain ECMAScript modules and has no npm install step.
- A Comfyrizz engine listening on loopback, and `COMFYRIZZ_ENGINE_URL` set to that origin (for example `http://127.0.0.1:4319`). Start it from the [Comfyrizz](https://github.com/mojomast/comfyrizz) checkout (`apps/server`, default port 4319).
- When a paid route needs a provider credential, put that key in the environment that launches Hermes. The engine may already hold its own provider credentials; you do not need to duplicate them into this package.

## Environment

`mcp.json` forwards only `${VAR}` references. Nothing in this repository is a credential.

| Variable | Required | Meaning |
| --- | --- | --- |
| `COMFYRIZZ_ENGINE_URL` | for live tools | Loopback origin of the running engine. Unset, empty, or non-loopback: tools that need the engine return `stub: true`. |
| `COMFYRIZZ_TOKEN` | if the engine is token-protected | Engine access token. Hermes forwards it into the MCP process. The client also accepts `COMFYRIZZ_ENGINE_TOKEN` on a direct `node` run. Never paste a token into `mcp.json` or into chat. |
| `COMFYRIZZ_MCP_HTTP` | no | Leave unset for the Hermes stdio server. `1` switches this process to Streamable HTTP on `127.0.0.1` instead of speaking stdio. |
| `OPENCODE_API_KEY` | optional | Forwarded from your environment when present. This MCP process does not call OpenCode. |
| `OPENCODE_GO_API_KEY` | optional | Forwarded from your environment when present. This MCP process does not call OpenCode Go. |
| `OPENROUTER_API_KEY` | optional | Forwarded from your environment when present. This MCP process does not call OpenRouter. |

When a variable is unset or empty, Hermes omits that entry. The server does not receive the literal string `${NAME}`.

Leave `COMFYRIZZ_MCP_HTTP` unset in the environment that launches Hermes. If it is `1`, the process listens on loopback instead of speaking stdio, and Hermes cannot drive it. For a shared Streamable HTTP process, start it yourself:

```bash
node mcp/src/index.mjs --http
```

That listens on `http://127.0.0.1:4320/mcp` (override the port with `COMFYRIZZ_MCP_PORT` or `--port=`). It binds `127.0.0.1` only.

`COMFYRIZZ_ENGINE_URL` must be an `http` or `https` loopback URL (`127.0.0.1`, `localhost`, or `::1`) with no userinfo. Any other host is refused and the server stays in stub mode, so this process never becomes a remote spend or data path.

The three provider keys are passthroughs kept so a Hermes environment can supply the same names the Comfyrizz engine uses for planning. This server's HTTP client talks only to the loopback engine and attaches only `COMFYRIZZ_TOKEN` there. Paid generation is performed by the engine, after you accept a spend card.

## Stub mode and the real engine

| Condition | Behavior |
| --- | --- |
| `COMFYRIZZ_ENGINE_URL` is a loopback origin and the engine answers | Tools return project, plan, job, take, assemble, export, and retake data. |
| Variable unset, empty, or not loopback; engine down or unreachable | Tools that need the engine return `stub: true`. No generation starts and no spend is created. |
| `node mcp/src/index.mjs --http` or `COMFYRIZZ_MCP_HTTP=1` | The same tools over Streamable HTTP on `127.0.0.1` only. |

Stub results are for wiring checks. Start the engine before you expect real takes.

## Tools

Names are exact.

| Tool | Role |
| --- | --- |
| `comfyrizz_status` | Engine reachability, status, and stub indicator |
| `comfyrizz_create_project` | Create a project for a film |
| `comfyrizz_list_projects` | List projects |
| `comfyrizz_plan` | Turn a brief into a plan in chat. Planning does not spend. |
| `comfyrizz_get_plan` | Read the current plan |
| `comfyrizz_get_spend_card` | Show the spend card for the planned generation |
| `comfyrizz_accept_generation` | Record explicit acceptance. Requires `approvalId`, otherwise `APPROVAL_REQUIRED` |
| `comfyrizz_job_status` | Progress for a generation job |
| `comfyrizz_list_takes` | Takes produced for the project |
| `comfyrizz_assemble` | CPU assembly of takes into the film |
| `comfyrizz_export` | Share-ready export |
| `comfyrizz_retake` | Retake of one shot or clip. A paid retake still needs its own acceptance |

A typical chat: `comfyrizz_create_project` → `comfyrizz_plan` → revise in chat → `comfyrizz_get_spend_card` → `comfyrizz_accept_generation` with the pending `approvalId` → `comfyrizz_job_status` → `comfyrizz_list_takes` → `comfyrizz_assemble` → `comfyrizz_export`, with `comfyrizz_retake` for one shot that needs another pass.

Calling `comfyrizz_plan` or `comfyrizz_get_spend_card` is not acceptance. `comfyrizz_accept_generation` must carry the pending `approvalId` plus `planId` and `planRevision`. Without an approval id the server returns `APPROVAL_REQUIRED` and does not call the engine. If the id is missing, stop and ask. There is no silent spend on Google Colab, the Comfy API, or ComfyUI.

## The `comfyrizz-film` skill

[`skills/comfyrizz-film/SKILL.md`](skills/comfyrizz-film/SKILL.md) keeps the conversation on that loop: plan first, revise on request, show the spend card, wait for an unambiguous yes, then generate and finish on CPU. "Looks good" accepts the creative plan, not the spend.

The same stdio server can be attached to another MCP client by launching `node` on `mcp/src/index.mjs` and passing `COMFYRIZZ_ENGINE_URL` (and `COMFYRIZZ_TOKEN` when the engine requires it) in that client's environment. Do not commit those values.

## Disclosure

What this package does when you enable it:

- **Local process.** The catalog server is stdio only. Hermes runs `node` on `mcp/src/index.mjs` inside the plugin root. That process speaks JSON-RPC on stdin/stdout and, when an engine URL is configured, makes HTTP requests only to that loopback URL.
- **Optional HTTP is opt-in and loopback.** Streamable HTTP binds `127.0.0.1` only, and only when you pass `--http` or set `COMFYRIZZ_MCP_HTTP=1`. The catalog `mcp.json` does not declare an HTTP or SSE server. Leave `COMFYRIZZ_MCP_HTTP` unset for Hermes.
- **Paid generation is gated.** Google Colab, Comfy API, and ComfyUI spend happens only after a spend card and an explicit `approvalId` sent to `comfyrizz_accept_generation`. The tools refuse without that id. This package does not start a Google Colab runtime on its own and does not bypass the engine's approval check.
- **Environment passthrough.** `COMFYRIZZ_ENGINE_URL`, `COMFYRIZZ_MCP_HTTP`, `COMFYRIZZ_TOKEN`, `OPENCODE_API_KEY`, `OPENCODE_GO_API_KEY`, and `OPENROUTER_API_KEY` are forwarded as `${VAR}` from your environment. The package contains no credentials, does not read `.env` files, and does not read Hermes credential stores.
- **No self-updater.** Nothing in this package checks for updates, downloads a replacement, or moves itself off the commit you installed (catalog rule 3).
- **No weights.** Comfy checkpoints and other model files are not vendored here.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Tools return `stub: true` | `COMFYRIZZ_ENGINE_URL` is unset, not loopback, or the engine is not running. Start the engine from the Comfyrizz repo and retry `comfyrizz_status`. |
| `APPROVAL_REQUIRED` | Expected until you accept. Fetch the spend card and pass its `approvalId` to `comfyrizz_accept_generation`, with `planId` and `planRevision`. |
| Server exits immediately | Node.js 22+ must be on `PATH`. `mcp/src/index.mjs` must still be inside the installed plugin directory. |
| Hermes does not list the plugin | Run `hermes plugins list`, confirm `comfyrizz` is enabled, and restart Hermes. |
| MCP HTTP connection refused | Start with `node mcp/src/index.mjs --http` and use `http://127.0.0.1:<port>/mcp`. It does not listen on other interfaces. |
| Engine returns HTTP 401 | `COMFYRIZZ_TOKEN` is missing or does not match the engine token. |

## Development

```bash
node --test mcp/test/tools.test.mjs
node mcp/src/index.mjs --self-check
```

## See also

- [Comfyrizz](https://github.com/mojomast/comfyrizz) — the engine, the web app, and the full local setup
- [Hermes plugin catalog submission](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/catalog-submission) — how a listing is reviewed
