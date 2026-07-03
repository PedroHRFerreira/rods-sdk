# Context Engine

Local context memory for AI agents. The CLI indexes files into SQLite FTS5 chunks so agents can search and read only the snippets they need.

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
context --help
```

## Commands

```bash
context ingest <path> [--type file|log|markdown|diff|error|stacktrace|json|sql|http]
context search <query> [--limit 8]
context read <chunkId>
context stats
context project add <name> <root>
context project list
context project remove <name>
```

## Codex Integration

Context Engine also exposes a local MCP server for Codex:

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
