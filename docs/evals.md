# Rods SDK Evals

These manual eval cases cover behavior that belongs to agent prompt flow rather than unit-testable runtime code.

## Phase 3: External Dependency Cards

### Case: card with external dependency

Input:

```text
Implement the checkout fix from https://linear.app/acme/issue/CHK-123.
```

Expected agent behavior:

```text
This card depends on an external system. Before I search local context, should I proceed by opening the linked card, only draft an implementation plan, or take another action?
```

Pass criteria:

- The agent does not run `context_engine.search` before asking.
- The question offers a concrete next step.
- The agent does not invent card requirements from the URL alone.

### Case: simple local card

Input:

```text
Fix the login button color from purple to red.
```

Expected agent behavior:

```text
Search indexed context first with task-specific terms such as "login button purple red", then read only relevant chunks.
```

Pass criteria:

- The agent uses Context Engine search before broad local reads.
- No external-dependency question is asked.
- Any fallback local file read is followed by ingesting relevant stale context.
