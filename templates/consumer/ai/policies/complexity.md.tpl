---
simple:
  maxFiles: 2
  maxLayers: 1
medium:
  maxFiles: 7
  maxLayers: 2
high:
  minFiles: 8
  minLayers: 3
epicPhrases:
  - sistema de
  - completo
  - geral
  - tudo
dependencyRaisesTo: medium
layers:
  - frontend
  - backend
  - src
  - server
  - app
  - packages
  - templates
  - docs
  - test
---

# Complexity policy

Edit the frontmatter to tune deterministic classification for this project. The classifier never calls an LLM and never changes the active model.
