---
harness: claude
lastVerified: 2026-07-09
harnessVersionTested: unknown
---

# Claude Code capabilities

- Lifecycle events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`.
- Handler used by rods: `command` for parity with Codex.
- Project hooks: `.claude/settings.json`.
- Fallback: textual recommendation if hooks are disabled or unavailable.
