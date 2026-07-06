# RTK.md

## Rods SDK Codex Hook

{{baseHook}}

Codex projection:

- Prefer MCP `context_engine.search` before local file reads.
- Prefer MCP `context_engine.read` for explicit chunks.
- Use local file reads only when chunks are insufficient or stale.
