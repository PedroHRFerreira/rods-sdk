# Project Rules

- When a Figma design exists, always follow its responsive pattern.
- When a Figma design exists or the project is frontend, validate the result directly in a real browser with the `visual-check` skill before marking it done.
- If `visual-check` alone cannot complete the interaction, a browser MCP such as Playwright MCP is acceptable as a last resort while keeping workflow behavior in skills and MCP tools primitive.

## Local-First

- `--local-only` requires `LOCALITY_VERIFIED`; installation and readiness alone never qualify a runtime.
- Network isolation is independent of locality and is required only when the explicit Local-Only policy requires it.
- Magnitude may be discovered and diagnosed but is ineligible for `--local-only` until it produces equivalent locality evidence.
- A healthy runtime does not imply a healthy harness: Codex must independently provide a `HarnessRouteProof` for `--local-only`.
- When a required proof is unavailable, preserve fail-closed behavior and report the structured blocker; never weaken the proof criterion, parse undocumented internals, or silently fall back to cloud.
