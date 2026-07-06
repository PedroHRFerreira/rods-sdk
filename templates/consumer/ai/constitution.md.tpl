# Rods SDK Constitution

## Principles

1. Prefer indexed retrieval before broad local reads.
2. Prefer RTK for noisy shell output when available.
3. Keep execution CLI-first through the local agent harness, MCP tools, skills, and adapters.
4. Do not add direct AI provider API runners to this framework.
5. Keep external adapters optional and reversible.
6. Do not duplicate business logic or project rules across generated files.
7. Keep MCP tools primitive; put workflows and behavior in skills.
8. Optimize for small, auditable context instead of large prompt dumps.
9. If a card or link depends on external systems, pause before retrieval and ask whether to proceed, only plan, or take another action.
