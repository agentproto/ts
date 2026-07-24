---
"@agentproto/cli": minor
---

Add skill pack fetch from npm and github. `agentproto install skill/<name>` now fetches the published pack when nothing is on disk, resolving out-of-the-box with no `--pack` required. Adds `--refresh` flag to bypass cache. New exports: `parsePackSpec`, `fetchNpmPack`, `fetchGithubPack`, `fetchPack`, `PackSpec` type, `FetchOpts` and `ResolvePackOpts` interfaces. Extended `resolveSkillPackDir(pack?, { allowFetch?, refresh? })` with optional opts parameter (backwards compatible).
