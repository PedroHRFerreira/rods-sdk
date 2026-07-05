# Using rods-sdk With Codex

Rods SDK can run Context Engine as a local MCP server so Codex can search indexed project memory before reading files. RTK is the default command-output adapter, but RTK installation stays external and optional. Execution stays CLI-first through Codex, MCP, skills and local adapters; rods-sdk does not call AI provider APIs directly.

## Flow

```text
Codex chat
  -> context-engine MCP tool
  -> ~/.context-engine/db/context.db
  -> ranked chunks
  -> Codex answer or code edit
```

Codex does not send your whole repository to the model. It calls tools such as `search` and `read`, then includes only the selected chunks in the active turn.

## Local Setup

Clone and build the project on your notebook:

```bash
git clone https://github.com/PedroHRFerreira/rods-sdk.git
cd rods-sdk
npm install
npm run build
```

Index a project:

```bash
./bin/context project add my-project /absolute/path/to/my-project
./bin/context ingest /absolute/path/to/my-project
```

## Connect Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.context_engine]
command = "node"
args = ["/absolute/path/to/rods-sdk/dist/mcp/server.js"]
cwd = "/absolute/path/to/rods-sdk"
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true

[mcp_servers.context_engine.tools.search]
approval_mode = "approve"

[mcp_servers.context_engine.tools.read]
approval_mode = "approve"

[mcp_servers.context_engine.tools.stats]
approval_mode = "approve"
```

Or add it with the Codex CLI:

```bash
codex mcp add context_engine -- node /absolute/path/to/rods-sdk/dist/mcp/server.js
```

Restart Codex after changing MCP configuration. In the Codex TUI, run `/mcp` to confirm the server is active.

## How To Use In Chat

Ask normally, but mention Context Engine when you want to force the path:

```text
Use context_engine to search my indexed project before answering.
```

Useful first prompts:

```text
Use context_engine.search to find context about checkout errors.
Use context_engine.ingest on this project, then search for upload banner.
Read only the chunks needed from context_engine.
```

## Available Tools

- `search`: find relevant chunks by text.
- `read`: read one chunk by id.
- `ingest`: index a file or directory.
- `stats`: show compact database stats.
- `projects`: list registered projects.
- `project_add`: register a project root.

## Governance Files

For a project that should carry rods-sdk governance, run:

```bash
rods init /absolute/path/to/project
rods adapter sync /absolute/path/to/project --target codex
```

This creates `.ai/` as the versioned source of truth and syncs `.ai/skills/*/SKILL.md` into `.agents/skills/` for Codex. RTK is enabled by default in `.ai/config.json`; install RTK separately with `rtk init -g --codex` when you want command-output interception. Optional external tools such as `claude-mem` and `caveman` are enabled with `rods adapter enable <name>` and checked with `rods adapter doctor`.
