---
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-pi": patch
---

Windows fixes for the pi stack from the WIN11 #1637 field test (agentproto 1.7.1):

- driver-agent-cli proprietary arm: a dynamic `import()` of an ABSOLUTE filesystem path
  (the fully-resolved adapter produced by `withResolvedProprietaryAdapter`) failed on
  win32 with `ERR_UNSUPPORTED_ESM_URL_SCHEME` / `Received protocol 'c:'`. Absolute paths
  are now rewritten via `pathToFileURL()` before `import()`; bare npm specifiers import
  as before. POSIX behavior is unchanged.
- adapter-pi: `spawn pi ENOENT` on win32 — the installed binary is a `.cmd` shim
  (`pi.cmd` on PATH, wrapper reapps of `%USERPROFILE%\.pi\agent\bin` or the npm global
  prefix) and Node's spawn without `shell` does no PATHEXT resolution. pi session spawns
  now resolve the binary through PATH; a `.cmd`/`.bat` shim is rewritten to its package
  entry JS (`node <…>/pi-coding-agent/dist/bundle/cli.js`) when a sibling exists, else
  spawned with `shell: true` (args are internal constants only).
