{
  "version": 3,
  "project": "{{projectName}}",
  "source": ".ai",
  "execution": {
    "mode": "cli",
    "apiEnabled": false
  },
  "escalation": {
    "enabled": true,
    "policyPath": ".ai/policies/complexity.md",
    "specsDir": "docs/rods/specs",
    "mode": "advisory"
  },
  "defaultTarget": "codex",
  "targets": {
    "codex": {
      "enabled": true,
      "hooks": true,
      "execution": {
        "binary": "codex",
        "models": { "simple": "", "medium": "", "high": "" },
        "args": [],
        "timeoutMs": 900000
      }
    },
    "claude": {
      "enabled": false,
      "hooks": true,
      "execution": {
        "binary": "claude",
        "models": { "simple": "", "medium": "", "high": "" },
        "args": [],
        "timeoutMs": 900000
      }
    }
  },
  "adapters": {
    "rtk": {
      "enabled": true
    },
    "claude-mem": {
      "enabled": false
    },
    "caveman": {
      "enabled": false,
      "mode": "opt-in"
    }
  },
  "workflow": {
    "mode": "codex",
    "maxIterations": 3
  },
  "generatedTemplates": {}
}
