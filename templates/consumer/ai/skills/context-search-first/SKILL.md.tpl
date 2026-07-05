---
name: context-search-first
description: Use when starting a task in this repository before reading files manually or assuming where code lives.
---

# Context Search First

## When To Use

- At the start of every repository task.
- Before raw file reads, broad grep scans, or assumptions about implementation.
- After compaction or session restore when local context is incomplete.

## Steps

1. Call `context_engine.search` with task-specific terms.
2. Read only relevant chunks with `context_engine.read`.
3. Open local files only when the indexed chunks are insufficient.
4. If local fallback found missing context, call `context_engine.ingest` for that file or directory.
