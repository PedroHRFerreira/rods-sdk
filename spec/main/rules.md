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
- Treat execution harnesses as replaceable: keep Codex supported, but make it ineligible for `--local-only` while `verifiedLocalRoute` is false.
- Admit an alternative harness to `--local-only` only when a documented, structured contract proves the active provider, resolved endpoint, effective model, correspondence to the verified runtime, authentication requirement, and absence of cloud fallback.
- `--local-only` may alternatively use network confinement only when controlled harness configuration, a verified same-machine runtime/model, and OS-enforced external-network blocking compose an `EffectiveRouteProof`; configuration alone is never sufficient.
- Network confinement must prevent, not merely observe, outbound traffic; it must allow only the verified local runtime endpoint and require zero successful external connections.
- Implement confinement per platform and fail closed where it is unavailable; Linux is the first supported target.
- When an implementation phase is correct and validated, always create its commit and proceed directly to the next planned phase.
