---
name: mastracode-inprocess
id: mastracode-inprocess
description: Mastra Code driven in-process via the mastracode SDK — no subprocess spawn.
version: 0.1.0
bin: in-process
install:
  - method: npm
    package: "@agentproto/adapter-mastracode-inprocess"
version_check:
  cmd: npm view mastracode version
  parse: '(\d+\.\d+\.\d+)'
  range: ">=0.27.0"
  timeout_ms: 15000
sandbox:
  model: in-process
  note: >-
    Runs inside the host process — no subprocess boundary. File/shell tool
    access is whatever Mastra Code's own tool policy grants for the session,
    with the host process's OS permissions.
protocol: proprietary
adapter: "@agentproto/adapter-mastracode-inprocess"
tags: ["mastracode", "mastra", "proprietary", "in-process", "agent-runtime", "coding"]
---

# Mastra Code (in-process) adapter

This adapter drives Mastra Code directly through its `mastracode` /
`mastracode/headless` SDK (`createMastraCode` + `runMC`) instead of spawning
`npx mastracode` as a subprocess. It implements the AIP-45 `protocol:
"proprietary"` arm contract: `createAgentCliRuntime` skips the subprocess
spawn entirely for this manifest and dynamic-imports this package, calling
its exported `createAgentCliClient(definition)` factory (see
`src/client.ts`).

## Why a separate package instead of extending `@agentproto/adapter-mastracode`

`@agentproto/adapter-mastracode` is a `protocol: "print"` arm: every turn
spawns a fresh `npx mastracode --prompt ... --output jsonl` process and
resumes prior turns via `--thread <id>`. This package wraps the *same*
underlying agent but through its SDK surface, in the host's own process.
Those are genuinely different runtime shapes, not a config toggle on one
package:

- **Dependency surface.** The print arm has zero npm dependency on
  `mastracode`/`@mastra/core` — it only needs the CLI binary on `PATH` (or
  fetched on demand via `npx`). This package takes `mastracode` and
  `@mastra/core` as real `dependencies`, pinned to versions this adapter is
  tested against. Merging them would force every consumer of the print arm
  to pull in the full SDK even when they never use it, or force every
  in-process consumer onto whatever CLI version happens to be on `PATH`.
- **Process lifecycle.** The print arm's `AgentCliClient` has no live
  connection between turns — `connect()`/`close()` are no-ops and each
  `send()` spawns and tears down its own child. This package's client holds
  a long-lived `MastraCodeHandle` (`controller` + `session`) across
  `connect()` → many `send()`s → `close()`, and that handle's lifecycle
  rules (in particular the resourceId/threadId binding documented below)
  don't map onto a stateless one-shot-per-turn model at all.
- **Session-id shape.** The print arm's resumable id is a bare Mastra
  thread id, passed straight through `--thread <id>`. This package's
  `sessionId` is a composite `"<resourceId>:<threadId>"` (see below) — a
  format specific to how `runMC()` resolves threads for a live, in-process
  `AgentController`. Encoding two incompatible id formats behind one
  `protocol` field would require a runtime discriminator the AIP-45 spec
  doesn't have a slot for, and would silently break resume for whichever
  shape wasn't the one actually in use.
- **Independent versioning/failure domain.** The print arm can keep
  shipping fixes to its subprocess/argv handling without ever touching (or
  re-testing) the in-process SDK surface, and vice versa. A shared package
  would couple their release cadence and blast radius for no shared code —
  `mapMastraEvent`/`createMastraMapperState` (the only genuinely shared
  logic, the wire-event → `StreamEvent` mapper) is exported from
  `@agentproto/driver-agent-cli` precisely so both packages can reuse it
  without merging everything else around it.

A new adapter slug (`mastracode-inprocess`) keeps both discoverable
independently via `adapter_list` / `agentproto install`, lets a host pick
whichever runtime shape it actually wants (subprocess isolation vs.
in-process, no `npx` cold-start), and keeps this package's `dependencies`
honest about what it actually needs.

## The composite sessionId

A single Mastra Code `AgentController` auto-binds a session to whatever
thread `session.thread` currently points at, and (verified against
mastracode 0.27.0 / @mastra/core 1.48.0) `runMC()` only rebinds that
pointer when a thread is explicitly passed. Two unrelated conversations
sharing this arm's dedicated storage file would otherwise silently land on
the same thread, because Mastra Code resolves the initial thread lookup by
`resourceId` and every conversation was defaulting to the same one.

The fix: a distinct `resourceId` per *conversation* (not per process, not
via a global env var, which would race across concurrent in-process
conversations in the same daemon). A fresh conversation mints a random
`resourceId`; resuming one must reuse the exact `resourceId` the thread was
created under, since thread-by-id resolution is scoped to the session's
current `resourceId`. So this arm's public `sessionId` is
`"<resourceId>:<threadId>"` — hosts only need to persist and echo back
whatever string `sessionId` returns, per the generic `AgentCliClient`
contract; the composite format is this arm's own implementation detail.

Cross-process resume (kill the process, start a new one, reattach via the
same composite `sessionId` against the same dedicated storage file) has
been verified to preserve conversation memory end-to-end.

## Isolation

- **Storage**: a dedicated libsql file under
  `$AGENTPROTO_HOME/mastracode-inprocess/storage.db` (default
  `~/.agentproto/...`), never the ambient global `mastracode` storage a
  developer's own interactive CLI use would touch.
- **Home dir**: a dedicated, empty home directory for Mastra Code's global
  config discovery (`~/.claude/skills`, `~/.mastracode/*`, `~/.agents/skills`),
  so this arm never implicitly inherits an operator's personal Claude
  Code / Mastra Code setup. A target repo's own project-local
  `.claude/skills` (relative to `cwd`) is unaffected — that's the repo's
  own content, not the operator's personal config.

## Modes and options

Mode selection has no argv to append to (there's no spawn) — modes patch
env instead, the one channel `composeSpawn` threads through for every
protocol regardless of whether a subprocess exists. `plan` / `build` /
`fast` set `AGENTPROTO_MASTRACODE_MODE`, which `client.ts` reads and
applies via `session.mode.switch(...)` before the next turn. `model` and
`effort` are declared as options so a host's generic
`agent_start({ model, effort })` passthrough works without the runtime
config validator rejecting them as unknown.
