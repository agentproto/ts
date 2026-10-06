---
"@agentproto/app-kit": patch
"@agentproto/cli": patch
---

`app pack --release` also leaves out tests (root `test/` and `tests/`, `__tests__/` and `*.test.*` / `*.spec.*` anywhere), the root `README.md`, `CHANGELOG.md` and `CONTRIBUTING.md`, and repo tooling config (`.github/`, editor folders, `tsconfig*.json`, test runner and lint configs). `LICENSE` still ships.
