# Using Context Engine With Codex

Context Engine can run as a local MCP server so Codex can search your indexed project memory before reading files.

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
git clone https://github.com/PedroHRFerreira/context-engine.git
cd context-engine
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
args = ["/absolute/path/to/context-engine/dist/mcp/server.js"]
cwd = "/absolute/path/to/context-engine"
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
codex mcp add context_engine -- node /absolute/path/to/context-engine/dist/mcp/server.js
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
