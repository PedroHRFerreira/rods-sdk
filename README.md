# rods-sdk

Agent governance framework with Context Engine retrieval and RTK-first token economy.

Rods SDK gives coding agents a small, auditable operating layer:

- Context Engine: indexed project retrieval with SQLite FTS5 chunks.
- RTK by default: compact shell output for commands, tests, logs and diffs.
- Skills and governance files: versioned `.ai/` rules that can sync to supported agents.
- Optional adapters: cross-session memory and terse output modes without making them required dependencies.
- CLI-first execution: rods-sdk runs through the local harness, MCP, skills and adapters, not through direct AI provider APIs.

## Install

```bash
npm install
npm run build
```

During development:

```bash
npm run dev -- search "query"
```

After build, the package exposes:

```bash
rods --help
context --help
```

`context` remains as a compatibility alias for the same CLI.

## Commands

```bash
context ingest <path> [--type file|log|markdown|diff|error|stacktrace|json|sql|http]
context search <query> [--limit 8]
context read <chunkId>
context stats
context project add <name> <root>
context project list
context project remove <name>
rods init [path] [--force]
rods adapter list
rods adapter enable <rtk|claude-mem|caveman> [path] [--force]
rods adapter sync [path] --target codex [--force]
rods adapter doctor [path] [--target codex]
```

## Codex Integration

Rods SDK exposes the Context Engine MCP server for Codex:

```bash
npm run build
context-mcp
```

See [docs/codex.md](docs/codex.md) for `~/.codex/config.toml` setup and usage.

## Storage

Default files are stored under:

```text
~/.context-engine/
  config/config.json
  db/context.db
```

Set `CONTEXT_ENGINE_HOME` to isolate storage for tests or local experiments.

## Token Economy

- Files are stored as line chunks, not as single large records.
- Search returns compact ranked chunk metadata and snippets.
- `read` requires an explicit chunk id.
- File hashes are cached to skip unchanged reindexing.
- The schema reserves embedding metadata fields for future hybrid search without implementing embeddings in the MVP.

## Governance Scaffolding

`rods init` creates project-level governance files without installing external tools:

```text
AGENTS.md
.ai/config.json
.ai/constitution.md
.ai/skills/context-search-first/SKILL.md
.ai/adapters/rtk.md
```

`.ai/` is the versioned source of truth. `rods adapter sync --target codex` copies `.ai/skills/*/SKILL.md` into `.agents/skills/` for Codex-local consumption.

RTK is enabled by default in `.ai/config.json`. Run `rtk init -g --codex` separately when you want RTK to install its own Codex integration.

Execution is CLI-first by default:

```json
{
  "execution": {
    "mode": "cli",
    "apiEnabled": false
  }
}
```

## Optional Adapters

Adapters document and validate optional tools. They are not bundled dependencies and rods-sdk does not reimplement their behavior.

- `rtk`: default shell command output compaction.
- `claude-mem`: persistent memory across sessions.
- `caveman`: opt-in terse agent output.

Use `rods adapter enable <name>` to mark intent in `.ai/config.json` and generate `.ai/adapters/<name>.md`. Use `rods adapter doctor` to check installation, detected config, hooks, MCP signals, and possible conflicts.
