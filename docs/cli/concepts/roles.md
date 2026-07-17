# Roles

A **role** is a spawn-time profile that decides whether a spawned
agent may itself delegate — spawn or drive further children — and,
if so, which roles it's allowed to spawn. It's set once, at
`agent_start`, and enforced by the daemon for the life of the
session.

Roles are an MCP/HTTP surface today — there is no `agentproto
sessions start --role` flag. Set `role` on the `agent_start` MCP tool
or the `POST /sessions/agent` HTTP body; see [below](#cli-surface).

## The 3-layer profile

A role bundles three things:

- **`disposition`** — a system-prompt fragment prepended to the
  child's first turn. Soft: it sets the mindset ("you are the leaf,
  do the work yourself" vs. "decompose, delegate, verify"), but
  nothing stops a capable model from ignoring it if the tools to
  disobey are still in its hands.
- **`toolPolicy.delegation`** (`"allow"` | `"deny"`) — the delegation
  gate. When `"deny"`, the daemon tries to keep `agent_start`/
  `agent_prompt` out of the child's toolset at spawn time — but this is
  spawn-path-specific and, on the default gateway, not airtight. It's a
  real gate on the orchestrator sub-gateway path and a best-effort
  default elsewhere; see [below](#how-the-delegation-gate-works) for
  which paths it covers and where it leaks.
- **`skills[]`** — declared but currently inert. The field is typed on
  `RoleProfile` (`role.ts:33`) and parsed from a role pack's `ROLE.md`
  (`role-pack.ts:84`), but nothing in the spawn path reads
  `role.skills` — `session-spawn.ts` only consults the `agent_start`
  call's own `skills` and the config `defaults.skills`
  (`session-spawn.ts:580,652`). `role.ts:12-13` flags it as intended
  for "a future pack-carried role"; treat it as unimplemented, not a
  working per-role skill set.

Plus two fields that place the role in the spawn lattice:

- **`level`** (number) — privilege level; higher is more privileged.
- **`spawnableRoles`** (optional string array) — a closed allowlist of
  role names this role may spawn, by name. When set, it replaces the
  level comparison below for this role.

## How the delegation gate works

`toolPolicy.delegation` is resolved at the `agent_start` injection
point (`session-spawn.ts:510`), before the child runs — but it is not
one universal, airtight gate. It acts through two separate spawn-time
mechanisms, and a third path escapes it entirely:

- **Orchestrator sub-gateway — genuinely gated.** A role that denies
  delegation has its `orchestrator` request dropped outright, whatever
  the caller asked for (`session-spawn.ts:547`, guarded on
  `!delegationDenied`). The scoped sub-gateway (`/mcp/orchestrator`) is
  the only path that mounts `agent_start`/`agent_prompt` for an
  orchestrating child, and it demands a scope token — it deliberately
  does *not* inherit the loopback bypass (`http-server.ts:668-675`). A
  denied role never receives the sub-gateway, so it has nothing to
  spawn with.
- **hermes default gateway — best-effort, loopback-open.** Only when
  the adapter is `hermes` *and* the caller passed no explicit
  `mcpServers`, the daemon defaults the child to its own `/mcp` URL,
  and for a denied role appends `?denyTools=agent_start,agent_prompt`
  (`session-spawn.ts:538-542`; `DELEGATION_TOOL_NAMES`, `role.ts:64`).
  The daemon reads that deny-list back from the requesting URL's own
  query string (`parseDenyToolsQuery` → `handleMcp`,
  `http-server.ts:652-666`), not from a trusted per-session registry.
  And the bare `/mcp` endpoint is loopback-open: any request from
  `127.0.0.1`/`::1` without an `X-Forwarded-For` header skips the token
  check (`authorize`/`isLoopback`, `http-server.ts:479-491`). A
  co-located child handed the gated URL can therefore reconnect to the
  plain `/mcp` and get `agent_start`/`agent_prompt` back — on this path
  the strip is a default, not a wall.
- **Caller-supplied `mcpServers` / non-hermes adapters — not touched.**
  If the caller passes explicit `mcpServers`, or the adapter isn't
  `hermes`, the `denyTools` default never fires
  (`session-spawn.ts:525,538`). Whatever delegation tools such a child
  ends up with are whatever the caller wired; `toolPolicy.delegation`
  does not reach in and remove them.

The part that `toolPolicy` locks down hard is the orchestrator sub-gateway:
`promptAppend` can't re-open it (it's never consulted at the drop,
`session-spawn.ts:547`) and a child can't mint its own scope token.
`promptAppend` layers text on top of the resolved role's disposition —
it can specialize it, never replace it. Beyond that path,
delegation-deny is a spawn-time default the child's own wiring can
route around, not a universal sandbox — and the daemon still cannot
strip a native CLI subagent/Task tool it never routed in the first
place (see the built-ins below).

## The two built-ins

| Role | `level` | `toolPolicy.delegation` | Disposition |
|------|---------|-------------------------|--------------|
| `executor` | 0 | `deny` | Leaf — execute the task directly, never spawn or delegate. |
| `supervisor` | 100 | `allow` | Decompose, delegate the parts that benefit from a separate agent, verify their output. |

Both built-in dispositions explicitly tell the agent not to use its own
CLI's native subagent/Task tool: the daemon cannot strip tools that are
not routed through its MCP gateway, so the rule must be followed in the
prompt. `executor` is told never to spawn or delegate; `supervisor` is
told to delegate via `agent_start` so the caller gets an observable
session.

`executor` is the floor of the lattice — `canSpawn` short-circuits to
`false` for any role whose own `delegation` is `"deny"`
(`role.ts:192-194`), before the level comparison, so an `executor` may
spawn nothing, not even a peer at its own level. Whether the child even
holds `agent_start` to attempt it is the separate, weaker toolset
question covered [above](#how-the-delegation-gate-works).

## `canSpawn`: the non-escalation rule

Every spawn made *through* an orchestrator sub-gateway (a session
started with `orchestrator: true`/`{...}`) is gated by `canSpawn(parentRole,
childRole)`, checked before the child's tools are ever injected:

1. If the parent's own `toolPolicy.delegation` is `"deny"`, it can
   spawn nothing — full stop. The lattice below is moot.
2. Else, if the parent has `spawnableRoles` set, the child must be
   named in that allowlist.
3. Else (the default, open mode): **non-escalation** —
   `child.level <= parent.level`. A role may spawn a peer or a
   subordinate, never something more privileged than itself.

Unbounded same-level recursion (a supervisor spawning a supervisor
spawning a supervisor) is allowed by this rule — it's a separate,
deliberate pattern bounded by the orchestrator's `maxDepth` /
`maxChildren` caps, not by the role lattice.

Worked example with the built-ins:

- `supervisor` (level 100) may spawn `executor` or `supervisor`.
- `executor` (level 0, delegation denied) may spawn nothing.

A denied spawn returns `role_spawn_denied` with the parent/child role
names and levels, plus (in allowlist mode) the allowed set.

## Depth-derived default

Omitting `role` on `agent_start` doesn't leave the child roleless —
it derives one from spawn depth against a cutoff:
`depth < cutoff` → `supervisor`, `depth >= cutoff` → `executor`. The
cutoff defaults to `1` (root spawns default to `supervisor`; spawns
made through an orchestrator sub-gateway default to `executor`) and
is overridable via `defaults.defaultRoleDepthCutoff` in
`~/.agentproto/config.json`.

## Introspection

### `role_list`

The `role_list` MCP tool enumerates every role the daemon currently
knows — the two built-ins plus any installed role pack — read-only,
pure visibility into the same registry `agent_start`'s `role` field
and the spawn gate use:

```json
{
  "roles": [
    { "name": "executor", "level": 0, "delegation": "deny", "spawnable": [] },
    { "name": "supervisor", "level": 100, "delegation": "allow", "spawnable": ["executor", "supervisor"] }
  ]
}
```

`spawnable` is precomputed with the same `canSpawn` check the daemon
uses at spawn time, so a caller can discover what it may spawn before
attempting `agent_start` with `orchestrator`.

### The "Roles you may spawn" context line

When a delegating role's disposition is composed into the child's
first turn, a line is appended automatically if its spawnable set is
non-empty:

```
Roles you may spawn: executor, supervisor.
```

This lets a delegating agent know its options at runtime instead of
guessing. It's omitted entirely for a role with an empty spawnable
set (an `executor` sees nothing extra).

## Pack-carried custom roles

Beyond the two built-ins, a role can be installed as a **role pack**
— discovered the same way skill packs are (`packages/cli/src/commands
/skill-install`):

- **Standalone**: `<dir>/roles/<slug>/ROLE.md`, one folder per custom
  role — `~/.agentproto/roles/<slug>/ROLE.md` in production.
- **Adapter-carried**: any installed `@agentproto/adapter-*` package
  may declare `metadata.roles: string[]`, each entry raw `ROLE.md`
  markdown embedded directly in the package.

### `ROLE.md` format

Frontmatter (flat `key: value`, dotted keys, comma-separated lists —
no YAML dependency) plus a body that becomes the disposition
verbatim:

```markdown
---
role: reviewer
level: 50
toolPolicy.delegation: deny
skills: code-review, security-review
---

You review code for correctness and security issues. You do not
edit files or spawn sub-agents — flag problems, suggest fixes, and
let the calling agent decide what to do with your findings.
```

Required fields: `role` (the name), `level` (a finite number),
`toolPolicy.delegation` (`allow` or `deny`). Optional: `skills`,
`spawnableRoles` (both comma-separated) — but `skills` is parsed and
then ignored (see [the 3-layer profile](#the-3-layer-profile)); only
`spawnableRoles` currently affects behavior. A malformed `ROLE.md` throws
when parsed directly, but registry loading treats a broken pack as
partial-discovery-safe — it's skipped, not fatal to the whole
registry.

**Built-ins always win a name collision** — a pack cannot shadow or
widen `executor`/`supervisor`, regardless of where the merged
registry is consumed (`resolveRole`, `listRoles`, `spawnableRolesFor`
all merge through the same function).

### Trust boundary

Installing a role pack is an operator decision, same as installing an
adapter or a skill pack — a `ROLE.md` can declare
`toolPolicy.delegation: allow` at any level. The optional
`maxGrantableDelegation` knob (`defaults.maxGrantableDelegation` in
`config.json`) caps this: a pack that self-grants `allow` at a level
above the configured cap is forced to `deny` at load time — the pack
still declares its intent, but the daemon refuses to grant it. No cap
configured means no restriction.

## Relationship to `--orchestrator`

These answer different questions:

- **Role** — *may this child delegate at all, and if so, to whom?*
  The gate. Set via `role` on `agent_start`.
- **`--orchestrator`** — *mount the scoped sub-gateway so it actually
  can.* Set via `orchestrator` on `agent_start` (CLI: `--orchestrator`
  / `--orchestrator-json`, see [`verbs/sessions.md`](../verbs/sessions.md#start-adapter)).

A role that denies delegation drops `orchestrator` outright, no
matter what the caller requested. A role that allows delegation still
needs `orchestrator` (or caller-supplied `mcpServers`) mounted before
it has anything to spawn with.

## CLI surface

`agentproto sessions start` does not currently expose a `--role` or
`--prompt-append` flag — role assignment is MCP/HTTP-only:

- MCP: `agent_start`'s `role` (string) and `promptAppend` (string)
  fields.
- HTTP: the same fields on the `POST /sessions/agent` body.

`role_list` is likewise MCP-only today; there is no `agentproto
role-list` verb.
