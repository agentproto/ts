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
- **`toolPolicy.delegation`** (`"allow"` | `"deny"`) — the HARD gate.
  When `"deny"`, the daemon never injects `agent_start`/`agent_prompt`
  into the child's toolset in the first place. This is enforced at
  the spawn point, not by the child's own behavior.
- **`skills[]`** — an optional role-specific skill set (the two
  built-in roles ship empty; a pack-carried role can populate this).

Plus two fields that place the role in the spawn lattice:

- **`level`** (number) — privilege level; higher is more privileged.
- **`spawnableRoles`** (optional string array) — a closed allowlist of
  role names this role may spawn, by name. When set, it replaces the
  level comparison below for this role.

## Why the gate lives daemon-side

A process can bring its own disposition and skills — those are
portable, and a determined agent could talk itself past a prompt
instruction. What it can't do is strip tools the daemon already put
in its hands. That asymmetry is exactly why `toolPolicy` is resolved
and enforced at the `agent_start` injection point rather than left to
the prompt: an `executor` asked via `promptAppend` to "delegate
anyway" still has no delegation tools to delegate with. `promptAppend`
layers text on top of the resolved role's disposition — it can
specialize it, never replace it, and it can never reopen the tool
gate.

## The two built-ins

| Role | `level` | `toolPolicy.delegation` | Disposition |
|------|---------|-------------------------|--------------|
| `executor` | 0 | `deny` | Leaf — execute the task directly, never spawn or delegate. |
| `supervisor` | 100 | `allow` | Decompose, delegate the parts that benefit from a separate agent, verify their output. |

`executor` is the floor of the lattice — in practice it can't spawn
even a peer at its own level, since `toolPolicy.delegation: "deny"`
already strips `agent_start` before any level comparison happens.

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
`spawnableRoles` (both comma-separated). A malformed `ROLE.md` throws
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
