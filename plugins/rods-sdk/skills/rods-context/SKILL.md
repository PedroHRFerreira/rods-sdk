---
name: rods-context
description: Use when a user asks to search, index, or inspect project context with the RODS Context Engine before working in a repository.
---

# Retrieve context with RODS

1. If a `context_engine` MCP tool is available, search with a narrow query before reading broad files. Read the returned chunks that answer the question; use source files when the index is missing or stale.
2. Otherwise, use the installed CLI: `context project list`, then `context project add <name> <project-root>` if needed, `context ingest <project-root>`, `context search <query> --limit 8`, and `context read <chunkId>` for relevant results. Registering or ingesting a project writes to local Context Engine storage; do it when the user asks to set up or use RODS for that project.
3. Treat search results as pointers to repository evidence, not as proof that a file is current. For code changes, verify the relevant source before editing.
4. If `context_engine` and `context` are both unavailable, tell the user that the CLI is supplied by `@pedrohrferreira/rods-sdk` and offer the documented installation path. Do not invent search results.

The Context Engine stores its index under `~/.context-engine/` by default. `CONTEXT_ENGINE_HOME` can point it elsewhere.
