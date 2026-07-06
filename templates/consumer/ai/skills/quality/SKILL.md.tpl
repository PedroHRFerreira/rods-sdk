---
name: quality
description: Use before finishing implementation work or when validating readiness.
---

# Quality

Detected stack: {{stackLabel}}

## Validation Order

1. Run the smallest relevant test, lint, or typecheck first.
2. Expand validation only when the touched surface or risk requires it.
3. If validation cannot run, state why and provide the exact command.
4. Avoid unrelated formatting, renames, and refactors.
