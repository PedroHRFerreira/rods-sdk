---
harness: codex
lastVerified: 2026-07-09
harnessVersionTested: unknown
---

# Codex capabilities

- Lifecycle events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`.
- Handler used by rods: `command`.
- Project hooks: `.codex/hooks.json` (requires Codex trust review before execution).
- Fallback: textual recommendation if hooks are disabled, untrusted, or unavailable.
