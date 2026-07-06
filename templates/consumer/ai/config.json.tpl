{
  "version": 1,
  "project": "{{projectName}}",
  "source": ".ai",
  "execution": {
    "mode": "cli",
    "apiEnabled": false
  },
  "defaultTarget": "codex",
  "targets": {
    "codex": {
      "enabled": true
    },
    "claude": {
      "enabled": false
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
