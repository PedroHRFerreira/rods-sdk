{
  "version": 2,
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
    "modelAdviceOnly": true
  },
  "defaultTarget": "codex",
  "targets": {
    "codex": {
      "enabled": true,
      "hooks": true
    },
    "claude": {
      "enabled": false,
      "hooks": true
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
  "generatedTemplates": {}
}
