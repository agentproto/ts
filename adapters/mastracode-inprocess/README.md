# @agentproto/adapter-mastracode-inprocess

Mastra Code driven **in-process** via its `mastracode` / `mastracode/headless`
SDK, instead of spawning `npx mastracode` as a subprocess. Implements the
AIP-45 `protocol: "proprietary"` arm contract directly — no child process,
no argv, no JSONL pipe.

```ts
import { mastracodeInprocessRuntime } from "@agentproto/adapter-mastracode-inprocess"

const runtime = mastracodeInprocessRuntime()
const session = await runtime.start({ cwd: process.cwd() })

for await (const evt of session.send("Fix the failing test in src/foo.ts")) {
  console.log(evt)
}
await session.close()

// Resume later — same process or a fresh one — via the sessionId the
// first session returned:
const resumed = await runtime.start({ resumeSessionId: session.sessionId })
```

See `@agentproto/driver-agent-cli`'s `createAgentCliRuntime` for the generic
`AgentCliRuntime`/`AgentCliClient` contract this package implements.

## How it works

```
manifest (src/index.ts, protocol: "proprietary")
        │ createAgentCliRuntime skips the subprocess spawn
        ▼
createProprietaryProtocolArm  ──dynamic import──▶  this package
        │                                                │
        │                              createAgentCliClient(definition)
        ▼                                                ▼
   AgentCliClient  ◀── src/client.ts ── createMastraCode() + runMC()
        │
        │ mapMastraEvent (reused from @agentproto/driver-agent-cli's print arm)
        ▼
    StreamEvent
```

## Why this is a separate package from `@agentproto/adapter-mastracode`

That package spawns the CLI (`protocol: "print"`) per turn; this one holds
a live in-process `AgentController` across turns and never shells out.
Different dependency surface, different process lifecycle, different
session-id shape — see **MASTRACODE-INPROCESS.md** for the full rationale.

## Session ids

`sessionId` is a composite `"<resourceId>:<threadId>"` string — an
implementation detail of how Mastra Code resolves threads for a live
`AgentController`, documented in full in **MASTRACODE-INPROCESS.md**. Hosts
should treat it as an opaque string: persist whatever `sessionId` returns
and pass it back as `resumeSessionId` to resume, including across a
process restart.

## Isolation

Storage and Mastra Code's global home-dir config discovery are both
redirected to a dedicated location under `$AGENTPROTO_HOME` (default
`~/.agentproto/mastracode-inprocess/`), so this arm's sessions never
collide with — or leak into — a developer's own interactive `mastracode`
usage. See MASTRACODE-INPROCESS.md for specifics and a known limitation
around `homeDir` propagation.

## Modes and options

`modes` (`plan` / `build` / `fast`) and `options` (`model` / `effort`) are
declared on the manifest; see MASTRACODE-INPROCESS.md for how they reach
`client.ts` (env-carried mode selection, direct model/effort passthrough).

## Spec

See [AIP-45](https://agentproto.sh/docs/aip-45).
