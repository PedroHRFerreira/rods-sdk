# RTK Adapter

Purpose: compact shell command output before it enters the agent context. RTK is the default rods-sdk command-output adapter.

Recommended Codex setup:

```bash
rtk init -g --codex
```

Validation:

```bash
rtk --version
rtk gain
```

Rods SDK does not rewrite shell commands. RTK remains responsible for command interception and filtering while Context Engine remains responsible for indexed project retrieval.
