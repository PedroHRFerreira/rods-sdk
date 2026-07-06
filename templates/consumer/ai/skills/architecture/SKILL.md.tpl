---
name: architecture
description: Use when changes affect structure, ownership boundaries, dependencies, or the detected stack.
---

# Architecture

Detected stack: {{stackLabel}}

## Rules

1. Reuse existing modules, layers, and naming before creating new structure.
2. Keep transport, adapter, domain, and UI responsibilities separated.
3. Do not add abstractions unless they remove real duplication or clarify ownership.
4. Document any boundary change in the final response.
