# Build your own agent app

An **agentproto app** (AIP-53) bundles agents, the workflows they run, an
optional UI, and durable data into one versioned, installable unit. This
guide walks the whole path — concepts, authoring, UI, data, lifecycle,
testing, packaging — building one small example app along the way. Every
command below was run against a real local daemon while writing this guide.

Narrower guides exist for pieces of this: [scaffold with
`create-agentproto-app`](./create-agentproto-app.md), [which tools an app
agent can call](./app-agent-tools.md), and [distributing an app you already
built](./distribute-an-app.md). This guide is the map that connects them.

---

## 1. What an app actually is

An app dir is any folder with a `.agentproto/APP.md` (schema `app/v1`) plus
whatever it references:

```
my-app/
  .agentproto/APP.md                       # the manifest — id, agents, workflows, ui, data…
  .agentproto/agents/<id>/AGENT.md         # AIP-42 — one system prompt + tool allowlist each
  .agentproto/workflows/<id>/WORKFLOW.md   # AIP-15 — the steps an agent runs
  .agentproto/ui/index.html                # optional — a single-file panel
  data/                                    # durable app-scoped storage (app_data_*), gitignored
```

`defineApp().emit(dir)` (from `@agentproto/app-kit`) writes exactly this
shape; `loadAppHandle(dir)` reads it back and re-validates. The daemon's
`app_install`/`app_run`/`app_data_*` tools only ever care about `APP.md` and
what it points at — everything else in the folder is yours.

**The coupling `defineApp` enforces:** agent ids are unique, every
`agent.workflows[]` ref resolves to a bundled workflow, and every bundled
workflow is referenced by at least one agent. An app can also be **UI-only**
— `agents: []` plus a `ui` block — for a pure dashboard with no agent
behavior (five of the daemon's own builtin panels ship this way).

## 2. Scaffold, or author by hand

Two ways in:

- **Scaffolder** — `pnpm create agentproto-app my-app` (or `agentproto app
  init trame my-app` for the bare-minimum trame: one agent, one workflow, a
  gate, a stage-board UI, `data/DATA.md`, `scripts/verify.mjs`). Full flags
  and template comparison: [create-agentproto-app](./create-agentproto-app.md).
- **Author directly in TypeScript** with `@agentproto/app-kit` — what this
  guide does, because it makes every piece (agent, workflow, UI, data hint)
  visible in one file.

Here is the whole example app this guide builds and verifies —
**Notes Digest**: jot notes in a small UI, run an agent that condenses them
into a digest.

```ts
// build.mjs
import { readFileSync } from "node:fs"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"

const app = defineApp({
  id: "@acme/notes-digest",
  name: "Notes Digest",
  version: "0.1.0",
  description: "Jot notes in a small UI; an agent condenses them into a digest.",
  data: { dir: "data" },                       // app_data_* plane lives under <appDir>/data
  agents: [
    {
      agent: defineAgent({
        schema: "agent/v1",
        id: "digester",
        description: "Reads the saved notes and writes a short digest.",
        model: "claude-sonnet-5",              // a bare alias id — see §6
        tools: ["list_dir", "read_file", "write_file"],
        workflows: [{ ref: "digest-notes" }],  // must resolve to a bundled workflow
      }),
      body: [                                  // the AGENT.md body = the system prompt
        "You condense a user's notes into a digest.",
        "Read every file in data/notes/ (one note per .json file, shape in data/DATA.md).",
        "Write data/digest.md: a title line, then at most 5 bullets, then one line 'Notes: <count>'.",
        "Write only data/digest.md. Do not modify the notes.",
      ].join("\n"),
    },
  ],
  workflows: [
    defineWorkflow({
      id: "digest-notes",
      name: "Digest notes",
      description: "Run the digester, then check the digest exists.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "digest", kind: "agent", agent: { ref: "digester" }, prompt: "Digest the notes now." },
        { id: "check", kind: "gate", command: "test", args: ["-s", "data/digest.md"], cwd: "." },
      ],
    }),
  ],
  ui: {
    html: readFileSync(new URL("./ui/index.html", import.meta.url), "utf8"),
    title: "Notes Digest",
    tools: ["app_data_write", "app_data_read", "app_data_list", "app_run", "app_status", "app_stop"],
  },
})

await app.emit(new URL(".", import.meta.url).pathname)
```

Run `node build.mjs` and it writes `.agentproto/APP.md` + the `AGENT.md` +
`WORKFLOW.md` + `ui/index.html` for you — never hand-edit those, re-run the
script. `agentproto app validate .` confirms the bundle loads, the
attachment invariant holds, and (if the app declares `verify.command`) runs
it:

```text
$ agentproto app validate notes-digest --json
{ "ok": true, "findings": [] }
```

A note on `model:` — the AGENT.md's `model` field wants a **bare model
alias** the spawning adapter resolves itself (`claude-sonnet-5`, matching
every builtin app's `AGENT.md`), not a full catalog ref
(`vendor/product@route`, the shape `catalog_models` returns) and not a
`provider/model-id` pair. The bare alias is the one verified to run (a
direct `agent_start` with `model: "claude-sonnet-5"` ran the example's agent
end to end); the other forms were not tested here, so confirm with `app_run`
before shipping.

## 3. The UI: `window.McpApp`

A served app UI is one static HTML file that receives a `window.McpApp`
bridge. `connect()` resolves it; `bridge.callTool(name, args)` is the only
thing you need for most apps:

```html
<script>
window.McpApp.connect().then(bridge => {
  const call = bridge.callTool
  // call("app_data_write", { appId: "@acme/notes-digest", path: "notes/1.json", content: {...} })
})
</script>
```

Every tool id the UI calls **must** be in `APP.md`'s `ui.tools` allowlist —
`app_tool_call` (what the bridge actually dispatches through) refuses
anything not listed there, server-side, no exceptions.

Three ways to run this during development, in increasing fidelity:

| Command | What you get |
| --- | --- |
| `agentproto app dev <dir>` | A Vite dev server (only if `ui/` is a real Vite project) + live `window.McpApp` bridge — for the `react-ts` scaffold template. |
| `agentproto app serve <dir>` | The static `.agentproto/ui/index.html` served standalone, bridged to the daemon's real `/mcp`. |
| MCP-Apps host panel | The same HTML embedded inside a chat host (Cowork, Claude Desktop with MCP Apps). |

`@agentproto/app-client` wraps the raw bridge with mode detection
(`host` → `bridge` → `standalone`, so the same code renders with or without
a daemon nearby) plus TanStack Query hooks — reach for it if your UI is more
than a few `callTool`s. It also ships a drop-in stage-board renderer
(`/agentproto/stageboard.js`, served by both `app serve` and `app dev`) if
your app tracks pipeline stages instead of a flat dataset.

> **Not verified here:** the serve/dev paths above are described from the CLI
> source and `@agentproto/app-client` docs; this guide's verification run
> covered the `app_data_*` calls the UI makes (section 4), not a browser
> session against `app serve`.

## 4. Durable data: `app_data_*`

Generic `fs-*` tools are workspace-rooted — wrong tool for app storage. Use
the app-scoped plane instead, anchored to the installed app's own `dir`
with path-traversal rejection built in:

- **`app_data_read {appId, path}`** → `{exists, content}` — `.json` paths
  auto-parse.
- **`app_data_write {appId, path, content}`** → mkdir -p + atomic
  tmp-then-rename. `.json` paths are pretty-printed.
- **`app_data_list {appId, dir?}`** → `{entries: [{name, type, size}]}` —
  missing dir is an empty list, not an error.

Verified end to end against a real install:

```text
$ app_data_write {appId: "@acme/notes-digest", path: "notes/1.json", content: {id:"1", text:"Buy milk and eggs", createdAt:"…"}}
→ {"appId":"@acme/notes-digest","path":"notes/1.json","size":85}

$ app_data_list {appId: "@acme/notes-digest", dir: "notes"}
→ {"entries":[{"name":"1.json","type":"file","size":85},{"name":"2.json","type":"file","size":101}]}
```

Resolution order, so you never have to think about `data/` vs bare paths:
an app-relative path resolves under the app's **data dir** (`dataDir`,
default `<appDir>/data`); under that default layout a leading `data/` is
accepted as the legacy spelling (`data/trips/x.json` and `trips/x.json` name
the same file); a path that exists under the app's *source* dir but not yet
under its data dir (a pre-`dataDir` install) still resolves there, and
`app_data_list` merges both views. Document every key your app persists in
`data/DATA.md` — it's the contract the UI and agents code against, and the
scaffolder's `trame` template requires it when `data.dir` is declared.

## 5. The lifecycle

```text
app_install {dir}              # validate + register id → dir
app_apply {appId, scopeId?}    # activate it in a scope; checks `requires`
app_run {appId, agents?, …}    # spawn the app's agent(s) as live sessions
app_status {appRunId}          # poll session + workflow state
app_stop {appRunId}            # kill a run
app_uninstall {appId}          # remove the registration (data dir untouched)
```

`app_install` cross-validates every bundled `WORKFLOW.md` tool-step id
against the daemon's actual registered tools — a typo'd tool id is reported
at install time, not buried in a failed run later. Re-installing the same
`appId` upserts and keeps its existing `dataDir`.

Verified against a real local daemon:

```text
$ app_install {dir: "/path/to/notes-digest"}
→ {"appId":"@acme/notes-digest", "dataDir":"/path/to/notes-digest/data", "agents":[…], "ui":{...}}

$ app_data_write / app_data_list   # (§4 above — both ran against this exact install)

$ app_uninstall {appId: "@acme/notes-digest"}
→ {"appId":"@acme/notes-digest"}
```

### A gap found while verifying this guide: `app_run` on `mastra-agent`

`app_run` wraps every spawn in an **app boundary** — fs zones the daemon
builds from `app.dir` (read-only) and the data dir (writable), enforced
through an OS sandbox when the chosen adapter "supports fs zones". That
support flag isn't a per-adapter declaration — the daemon infers it as
`adapter.protocol !== "proprietary"` (`packages/cli/src/commands/serve.ts`),
which is true for `mastra-agent`, the first-party in-process adapter. Once
enforced, the macOS Seatbelt profile denies all of `$HOME` except a short,
explicit re-allow list (workspace, the app's own zones, `extraReadPaths`) —
and a spawned session's own `adapterConfigDir`
(`~/.agentproto/adapter-config/<sessionId>`, where the adapter persists its
provider/session config) is **not** on that list.

Net effect, reproduced consistently while writing this guide (fresh daemon
restart, zero other `mastra-agent` processes running, varying the prompt to
rule out dedupe): `app_run` on a `mastra-agent` app fails immediately with
`agent_start: spawn failed — ACP connection closed` and **no child process
ever starts** — while an equivalent `agent_start {adapter: "mastra-agent",
options: {agent: <AGENT.md path>}}` called directly (no app boundary)
spawns and completes the exact same task correctly every time. `app_status`
/ `app_data_*` / `app_install` / `app_uninstall` are all unaffected — only
the `app_run` spawn path is.

There is no caller-side knob to turn off today: `app_run`'s own MCP schema
doesn't expose `commandSandbox`, and an app's `boundaries.enforce` field
only changes refuse-vs-warn behavior when enforcement is already
impossible, not whether it's attempted. **If you're building a `mastra-agent`
app, test `app_run` against your actual target daemon before relying on it**
— a working `agent_start` with the same `agent` option doesn't guarantee
`app_run` will spawn cleanly. This is almost certainly fixable (either by
`adapterConfigDir` joining the re-allow list, or by `mastra-agent`
legitimately reporting `supportsFsZones: false` since its own "tools" are
already identity-confined by the daemon, not native Bash/Write) — filed as
a known gap, not a permanent limitation.

## 6. Model and harness pass-through

`app_run`'s `model`/`harness`/`adapter`/`access` arguments override the
`AGENT.md`'s own declared defaults for that one run, mirrored onto the run
record (visible in `app_list`/`app_status`). Wire a picker into your UI with
`@agentproto/app-client/runner-select` — it discovers installed
harnesses/models via `adapter_list` + `harness_preset_list` (your app's own
`callTool`, no extra daemon coupling) so you never hardcode a `<select>`:

```html
<script>
const runner = window.AgentprotoUI.mountRunnerSelect(el, { callTool: callApp })
await callApp("app_run", { appId: "my-app", agents: ["writer"], ...runner.getRunner() })
</script>
```

## 7. Testing

- **`agentproto app validate <dir> [--json]`** — the fast, local, no-daemon
  check: `loadAppHandle` succeeds, every workflow loads
  (`@agentproto/workflow-loader`), every `ui.tools` entry names a real
  daemon tool or an `app_*` tool, `data/DATA.md` exists if `data.dir` is
  declared, and — if `APP.md` declares `verify.command` — that command runs
  and its exit code becomes `validate`'s own exit code. This is what CI
  should gate on for an app repo.
- **The `trame` scaffold's `scripts/verify.mjs`** runs every `gates/*.mjs`
  check and prints `{ok, findings}` — the pattern to copy if you're not
  using the scaffolder: deterministic checks behind a workflow `kind: gate`
  step, one script that runs all of them.
- **Smoke-test an install**, per the `agentproto-apps` skill: install →
  serve → confirm the UI renders from durable data on a fresh load (not a
  stale/zero dashboard) → confirm a path-traversal probe
  (`app_data_read {path: "../etc/passwd"}`) is rejected → confirm a run
  reaches a terminal state.

## 8. Packaging and distribution

Three ways an app reaches another machine (full detail in [distribute an
app](./distribute-an-app.md)):

1. **Git** — `app_install {url, ref?, subdir?}`; `app_resync {appId}` later
   checks `git ls-remote` against the pinned commit.
2. **`.agentapp` bundle** — `agentproto app pack <dir>` walks the whole app
   dir, hashes every file, and emits a gzipped tar with a `manifest.json`
   carrying the aggregate `sha256`. `app unpack` recomputes and compares the
   hash before restoring — a corrupted bundle fails closed, nothing is
   written.
3. **Remote catalog** — a static JSON file `app_catalog` merges into the
   local view, for one-click installs from a UI.

Verified round-trip on the example app:

```text
$ agentproto app pack notes-digest --json
→ { "sha256": "30c5966a…", "fileCount": 11, … }
$ agentproto app unpack acme-notes-digest-0.1.0.agentapp --dir notes-digest-unpacked --json
→ { "sha256": "30c5966a…", "verified": true }
$ agentproto app validate notes-digest-unpacked --json
→ { "ok": true, "findings": [] }
```

`pack --release` additionally runs any declared `ui.build`, excludes
dev-only paths (`ui/**`, `docs/**`, `data/**`, `scripts/**`, `**/.env*`, …),
and strips `ui.build` from the packed `APP.md` so an install never runs a
build command from an untrusted source.

## 9. Apps using other apps

An app can declare `requires: ["@acme/shared"]` (or the object form
`{ apps: [...] }` alongside `browser`/`fs`/`gpu`/`secrets`). Today this is a
**dependency gate, not a call mechanism**: `app_apply` refuses to activate
an app in a scope until every id in `requires` is already applied there.
There is no runtime "call another app's agent and get a typed result" verb
yet, and no version pinning on `requires` (it's a flat list of app ids).

The adjacent `exposes: { agents, workflows }` / `accepts: { tasks }` fields
declare what an app would offer over A2A — but per `@agentproto/app-kit`'s
own docs, these are **semantics only**: nothing schedules or serves on them
today. Versioned, callable app→app composition is being designed on top of
this (`requires` gaining version ranges, `exposes` becoming a real dispatch
surface) — don't build against it yet; build against `requires` as a
same-scope activation order gate, which is what's actually enforced.

## 10. Pricing (AIP-55)

Pricing is a separate, attachable capability, not a field on `APP.md`.
`@agentproto/product`'s `defineProduct`/`attachPricing` points an AIP-54
ref at any artifact — including an app — with a price model (`one-time` |
`prepaid-pool` | `pay-per-call`, amounts in **minor units**) and an optional
billing rail (`stripe`, `autumn`, `tbd`):

```ts
import { attachPricing } from "@agentproto/product"

const priced = attachPricing(
  { aip: 53, id: "@acme/notes-digest" },
  { model: "one-time", amountMinor: 4900, currency: "usd" },
  { billingRail: { rail: "tbd" } },
)
```

The target AIP (here, AIP-53 apps) needs zero pricing awareness — the whole
point of AIP-55 is that "X has a price" is expressible without X's own spec
changing. See the [AIP-55 implementer guide](https://agentproto.sh/docs/aip-55)
for the full price-model/billing-rail matrix and worked examples.

## See also

- [`agentproto app` verb reference](../verbs/app.md) — every subcommand's
  full flag set.
- [Which tools can an app agent call?](./app-agent-tools.md) — the
  `tools:` allowlist resolution chain in detail.
- [Distribute an app](./distribute-an-app.md) — the three distribution
  primitives, in depth.
- AIP specs: [AIP-42](https://agentproto.sh/docs/aip-42) (agent),
  [AIP-15](https://agentproto.sh/docs/aip-15) (workflow),
  [AIP-53](https://agentproto.sh/docs/aip-53) (app),
  [AIP-55](https://agentproto.sh/docs/aip-55) (pricing).
