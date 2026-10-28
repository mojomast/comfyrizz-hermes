# Changelog

## 0.1.0

First catalog-ready portable Agent Plugins v1 package.

- Plugin root is the repository root: `plugin.json`, stdio `mcp.json`, and `skills/comfyrizz-film`.
- The MCP server lives in-tree at `mcp/` and is started with `${PLUGIN_ROOT}/mcp/src/index.mjs`.
- stdio is the catalog transport. Optional Streamable HTTP stays on `127.0.0.1` and only starts when deliberately enabled.
- Engine calls accept a loopback `COMFYRIZZ_ENGINE_URL` only. `COMFYRIZZ_TOKEN` is forwarded from the user environment and is never written into the package.
- Paid generation still requires a spend card and an explicit approval id. Tools return `APPROVAL_REQUIRED` without one.
- No self-updater and no Comfy weights.
