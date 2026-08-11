---
"@agentproto/cli": minor
---

**`agentproto app pack/unpack`**: bundle and unbundle agentproto apps as self-contained `.agentapp` tar.gz archives with SHA-256 integrity verification.

New subcommands:
- `agentproto app pack <appDir> [--out <path.agentapp>] [--json]` — walks an app folder (must have `.agentproto/APP.md`), computes an aggregate SHA-256 over every file, writes a manifest.json, and tars the contents into a `.agentapp` bundle.
- `agentproto app unpack <file.agentapp> [--dir <outDir>] [--json]` — extracts and verifies the bundle's SHA-256 before restoring, fails if corrupted.

Bundles include the entire app tree (agents, workflows, optional UI, loose files). Extraction yields `manifest.json`, `.agentproto/`, and relative paths identical to the original—round-trip stable for `readAppRefs` / `app_install`.
