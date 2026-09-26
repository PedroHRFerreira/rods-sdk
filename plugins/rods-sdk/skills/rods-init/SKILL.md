---
name: rods-init
description: Use when a user wants to initialize RODS in a project, plan project-specific agent skills, or refresh RODS-generated governance files.
---

# Initialize RODS

1. Confirm the target project root from the user's request or current workspace. Check that Node.js 20 or newer and the `rods` CLI are available. If the CLI is absent, explain that it comes from `@pedrohrferreira/rods-sdk` and install it only when the user authorizes installation.
2. In an interactive terminal, run `rods init <project-root>` and follow its planning conversation. Review its proposed skills against the project's actual stack and conventions before confirming the generated files. Let the user make the final choice when the wizard requests confirmation.
3. If the terminal is not interactive, explain that `rods init` uses deterministic scaffolding there. Use `rods init <project-root> --no-plan` only when the user wants that outcome; do not present it as an AI-planned skill set.
4. Existing skills may be customized. Preview changes with `rods upgrade <project-root> --dry-run` before an upgrade and preserve user changes. Use `rods adapter doctor <project-root> --target codex` to report integration status.
5. Report which files were created or updated and whether skill planning completed. If planning was canceled or unavailable, say so clearly.

`rods init` may update `AGENTS.md`, `.ai/`, Codex adapter files, and the user's Codex RTK hook. Inspect the preview and avoid running it against the wrong project.
