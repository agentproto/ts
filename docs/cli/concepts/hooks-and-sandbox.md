# Hooks and sandbox: two enforcement planes, one honest coverage limit

Two separate mechanisms answer "can an agent's command be controlled?" —
they are easy to conflate, and conflating them is the single most dangerous
mistake a workspace can make with this surface. This doc names them, says
which one a given policy needs, and states plainly how much of the
cross-harness catalog each one actually reaches.

## The two planes

**Plane 1 — semantic gate + logging.** The ACP `session/request_permission`
seam: when an adapter is about to run a tool, it can ask the daemon whether
to proceed, carrying the tool name and its `rawInput` (command/args). The
daemon evaluates a rule table against that request and decides
`allow | hold | deny` (`packages/runtime/src/sessions.ts:2406-2442`, rules
from `.agentproto/hooks.json` via `decide()` —
`packages/runtime/src/hooks-config.ts`). This is **soft**: it only fires for
adapters that raise the request, and only when the adapter's posture
requires asking at all — an adapter running in a bypass/accept-edits
posture never raises it, so a "deny" rule is silently a no-op there. It is
also **ACP-only**: harnesses with no ACP permission surface never reach this
seam regardless of rule config.

**Plane 2 — OS-level sandbox (blast radius).** `@agentproto/command-sandbox`
wraps a spawned process's argv through macOS Seatbelt (`sandbox-exec`) or
Linux bubblewrap (`bwrap`), denying filesystem access outside the workspace
and (in `strict` mode) all network (`packages/command-sandbox/src/index.ts`).
This is **unbypassable by the confined process** — it doesn't matter whether
the process asks permission, runs in-process, or belongs to a harness with
no ACP surface at all; the OS itself is enforcing the boundary. It has two
independent axes today:

- **`command_execute` confinement** — wraps one MCP-proxied shell command.
  Shipped and validated; reads `.agentproto/command-sandbox.json`'s
  top-level `mode` (`packages/runtime/src/command-tools.ts:294-345`,
  `loadSandboxConfig` in `command-sandbox/src/index.ts`). Default `"off"`.
- **Adapter-spawn confinement** — wraps the adapter's own child process at
  spawn, so it also confines whatever the harness does in-process (Bash,
  file edits, anything that never touches an MCP tool). This is the
  keystone that makes Plane 2 harness-agnostic: it binds the process
  boundary an in-process tool runs inside, which Plane 1 can never see.
  Shipped as of #617 (`packages/driver/agent-cli/src/command-sandbox-wrap.ts`);
  a first-class `adapterSpawn` key in `.agentproto/command-sandbox.json`
  plus `agent_start.commandSandbox` schema exposure is in flight as PR 6b
  (#629, open at the time of writing — see "Config surfaces" below for the
  shape it proposes).

**Which plane a policy needs:**

| Policy | Plane | Why |
|---|---|---|
| "log every command / tool call" | 1 | observability, not enforcement |
| "gate `git push` on a review" | 1 | workflow decision; needs the command string + a soft hold |
| "escalate migrations to a human" | 1 | intent-level, rule-matched |
| "block `rm -rf ~`; no network; writes only in cwd" | **2** | must be **unbypassable** — a soft Plane-1 hold is defeated by bypass posture or any in-process tool |

**Hard security must live in Plane 2. Never sell a Plane-1 hold as a
security boundary.** `hooks-config.ts` enforces this at config-load time: a
rule that declares `intent:"security"` cannot compile to `plane:"semantic"`
with action `"hold"` or `"deny"` — that combination throws a
`HooksConfigError` rather than silently under-enforcing (the "RISK-0 GUARD",
`packages/runtime/src/hooks-config.ts:127-135`). Security intent must be
expressed as `plane:"blast-radius"` instead, which today means engaging the
`command-sandbox.json` axes above — a `"blast-radius"` rule in `hooks.json`
is recorded for the record but has no enforcement effect at the Plane-1 seam
(`decide()` only ever consults `plane:"semantic"` rules,
`hooks-config.ts:279-285`).

## Cross-harness coverage — the three tiers

The catalog has 10 agent-CLI adapters
(`packages/cli/src/registry/catalog.ts`). `protocol:"acp"` is not, by
itself, a reliable signal for Plane-1 reach: two adapters declare it but run
tools in-process behind a local ACP host and never raise
`request_permission`. Ranked by what Plane 1 can actually do with each:

| Tier | Adapters | Raises `request_permission`? | Plane 1 reach | Plane 2 reach |
|---|---|---|---|---|
| **1 — Blockable** | claude-code, codex, hermes, opencode, openclaw | Yes, client-mediated | Log **and** gate/deny | Confined (both axes) |
| **2 — Observable only** | claude-sdk, mastra-agent | No — in-process, `bypassPermissions`; ACP is transport only | Log only (after the fact) | Confined (both axes) |
| **3 — Opaque** | pi, mastracode, mastracode-inprocess | No ACP surface at all | Neither, without a bespoke per-harness shim | Confined (both axes) |

**~5/10 harnesses are semantically gateable (tier 1). ~7/10 are loggable
(tiers 1+2). ~3/10 are opaque to Plane 1 entirely (tier 3).** State this
loudly on every surface that talks about "a cross-harness hook engine" — a
silent 50% cliff reads as 100% coverage, and that's the exact failure mode
this doc exists to prevent.

**Plane 2 confines all three tiers uniformly, once the adapter-spawn axis is
engaged for a workspace.** Because it binds the OS process boundary rather
than an ACP-reported event, it doesn't care which tier an adapter is in —
tier-3 pi/mastracode get the identical filesystem/network confinement tier-1
claude-code gets. This is why blast-radius policies belong in Plane 2: it's
the only layer with no coverage cliff.

## Config surfaces

**`.agentproto/hooks.json`** — Plane 1's rule table
(`packages/runtime/src/hooks-config.ts`). Each rule declares which plane it
needs and matches on tool name, a command regex, positional argv regexes, or
a path glob:

```json
{
  "version": 1,
  "rules": [
    { "id": "log-all-bash", "plane": "semantic", "match": { "tool": "Bash" }, "action": "log" }
  ]
}
```

Shipped actions on `main` today: `log | allow | hold | deny` (`"log"` never
changes the decision — it only tags a match for `tool_calls_list`). A
`"gate"` action — run a shell command at the seam and auto-resolve the held
permission from its exit code, with `git push` as the canonical first rule —
is in flight as PR 5 (#630, open at the time of writing).

**`.agentproto/command-sandbox.json`** — Plane 2's config, covering the two
axes above with deliberately separate keys (a misconfigured
`command_execute` jail breaks one shell command; a misconfigured
adapter-spawn jail breaks the whole session — a strictly bigger blast
radius that warrants its own explicit opt-in rather than inheriting the
other axis's setting):

```json
{
  "mode": "workspace",
  "adapterSpawn": { "mode": "workspace" }
}
```

`mode` (top-level) governs `command_execute`; `adapterSpawn.mode` governs
the adapter-spawn axis and is proposed by #629 (open). Both accept
`"off" | "workspace" | "strict"`; both fail the confined operation outright
if no backend is installed for the platform rather than silently running
unconfined.

## Open decision: promoting tier-2 to tier-1

`claude-sdk` and `mastra-agent` both run behind a local ACP host
(`adapters/claude-sdk/src/options.ts`, `adapters/mastra-agent/src/acp-host.ts`)
but currently configure it with `bypassPermissions`, so they
never raise `request_permission` and land in tier 2 (observable, not
gateable). Both **could**, in principle, bridge their SDK-level
`canUseTool` callback into a real `request_permission` call instead of
bypassing — which would move them from tier 2 to tier 1 for *semantic*
gating. Plane 2 already covers their blast radius either way (they're
confined identically to every other tier once adapter-spawn confinement is
engaged), so this is purely a Plane-1 gating-reach question.

This is **a decision for maintainers to make, not a task queued here** — it
trades a change in these two adapters' default posture (with whatever
latency/UX cost a real permission round-trip adds to a first-party,
in-process harness) against closing 2/3 of the tier-2 gap. Raised for
discussion, not scheduled.
