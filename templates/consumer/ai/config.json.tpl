{
  "version": 1,
  "project": "{{projectName}}",
  "source": ".ai",
  "execution": {
    "mode": "cli",
    "apiEnabled": false
  },
  "defaultTarget": "codex",
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
  }
}
