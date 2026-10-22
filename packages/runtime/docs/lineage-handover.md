# Lineage handover

**What it solves.** A persistent orchestrator (the "brain") is sometimes
replaced by a NEW session: a daemon restart, a wallet change, a
`continue-fresh`. The children it spawned (supervisors, executors) stay
attached to the OLD `parentSessionId`, so:

- the new brain cannot drive them - `agent_prompt` refuses with *"may only
  be driven by its owner … or allowPromptFrom"*;
- they cannot report to it - `message_parent` fails with *"cannot identify
  the calling session"* or *"no recorded parent"*.

**The mechanism.** The successor takes over the replaced session's POSITION
in the spawn tree. In the daemon, that position is exactly one pointer:
`SessionDescriptor.parentSessionId`. Every access decision already keys on
it:

| Decision | Where | Effect of the move |
| --- | --- | --- |
| Who may drive a session | `session-owner.ts` → `checkSessionOwnerGate` (rule 3 = the target's `parentSessionId`; rule 4 = its ancestors) | the successor becomes the child's owner; the replaced row loses that right |
| Where a child reports | `agent-tools.ts` → `message_parent` (resolves `self.parentSessionId`) | the report goes to the successor |
| Spawn-tree scoping | `orchestrator-gateway.ts` → `collectSubtree` | the subtree follows the pointer |
| Crash / staleness notices | `supervisor-notify.ts` (`notifyParentOnCrash`) | the notice reaches the successor |

So one pointer move carries the whole contract - no per-tool special
casing, and the same code path serves the host daemon and a box daemon
alike.

## The three surfaces

1. **`agent_start.succeeds: "<sessionId>"`** - the explicit declaration. The
   new session is declared the successor of another one. Authorized to the
   human operator, the replaced session itself, or the session that owns the
   replaced row; refused (BEFORE the spawn) for anyone else. On success the
   replaced row's LIVE children are re-parented onto the new session, and
   the new session inherits the replaced row's place in the tree.
2. **`session_continue_fresh`** - the automatic form. The fresh
   continuation is the successor of the row it continues, so the same
   handover runs inside `continueAgentSessionFresh` (which is also the path
   `session_migrate` and the context-rescue auto-continue take).
3. **`session_adopt { childIds, from }`** - the explicit re-parenting verb.
   Moves named children of `from` onto `from`'s DECLARED successor.
   Authorized to the human operator and to that declared successor only.

Every handover records the succession on both descriptors
(`from.succeededBy = to`, `to.succeeds = from` - persisted, so it survives a
daemon restart) and emits `session:lineage-handover` on the session event
bus (`from`, `successorSessionId`, `adopted`, `skipped`, `reason`, `actor`).
`skipped` holds the children left in place: not children of `from`, or not
re-parentable (a move that would create a cycle is refused). The automatic
paths only consider LIVE children; a dead child is moved only when named
explicitly through `session_adopt`.

## Files

- `packages/runtime/src/lineage-handover.ts` - the mechanism (pure
  helpers + `handoverLineage` + the two authority checks).
- `packages/runtime/src/lineage-tools.ts` - the `session_adopt` MCP verb.
- `packages/runtime/src/sessions.ts` - `SessionDescriptor.succeeds` /
  `succeededBy`, `registry.reassignParent`, `registry.setLineageSuccessor`,
  `registry.emitLineageHandover`.
- `packages/runtime/src/session-event-bus.ts` - the
  `session:lineage-handover` event.
- `packages/runtime/src/agent-start-schema.ts` / `agent-tools.ts` - the
  `succeeds` field and its handling.
- `packages/runtime/src/session-continue-fresh.ts` - the automatic handover.
- `packages/runtime/src/__tests__/lineage-handover.test.ts` - the tests.

## Known gap - sessions running INSIDE a box (E2B / computer)

**Symptom.** A session spawned in a sandbox box (or a computer-use box)
calls `message_parent` and gets *"no recorded parent"* (or *"cannot identify
the calling session"*): the box daemon's registry has no parent row for that
session, because the parent lives in the HOST daemon's registry.

**Why the host-side half is not enough.** The host already knows the parent:
`bootSandboxAgentSession` creates a HOST-side proxy row for the box session
and stamps `parentSessionId` on it. But the agent process runs INSIDE the
box, against the BOX daemon's own registry - and the box's row is a
different row, with no lineage. `message_parent` resolves the parent
locally (`agent-tools.ts`: `registry.get(selfId).parentSessionId`), so it
finds nothing.

**Why forwarding the lineage alone does not fix it.** Forwarding
`parentSessionId` in the forwarded `agent_start` (`session-spawn.ts`,
`startArgs`) would give the box row a parent id - but that id names a
session the box registry does not have, so delivery would still fail at
`registry.get(parentId)`. The missing piece is DELIVERY, not attribution.

**What a full fix needs (design, not implemented).**

1. *Forward the remote parent.* The host forwards, in `startArgs`, the
   parent session id AND a relay handle: the host daemon's reachable URL
   plus a short-lived, single-session-scoped token. The box's
   `agent_start` stores them on the box row as a "remote parent"
   (a new descriptor field, e.g. `remoteParent: { sessionId, url, token }`)
   instead of `parentSessionId`.
2. *Relay in the box.* `message_parent` (and `message_send` to the parent)
   must detect the remote parent and POST the envelope to the host's relay
   endpoint instead of looking it up in the box registry. The envelope must
   keep the daemon-attested `from` (the box session id) - the host stamps
   the host-side relation.
3. *Relay in the host.* The host endpoint authenticates the token,
   resolves the token's session id (never the payload's), and delivers
   through the ordinary `registry.sendMessage` path - so the parent sees a
   normal `session-message`, with the same urgency/steer semantics.
4. *Reachability.* This is the hard part: for a remote E2B box the host's
   loopback is unreachable from the box (the same reason the host never
   mounts its own `/mcp` URL into a box spawn - see the sandbox-orchestrator
   note in `session-spawn.ts`). The relay therefore needs either a
   reachable host URL (tunnel / public endpoint) or a PULL channel: the box
   queues the outbound parent-report in its own store and the host drains
   it over the provider channel it already uses to drive the box (`exec` for
   E2B, the controller API for computer boxes). The pull channel reuses
   today's plumbing and needs no new network surface; the push channel is
   simpler but needs a reachable host URL.

## What landed: the PUSH channel

The push channel of (1)–(3) is implemented (`packages/runtime/src/parent-relay.ts`):

- **Host → box.** At a sandbox spawn the host mints a SHORT-LIVED,
  SINGLE-SESSION-SCOPED relay token bound to (parent session id, host-side
  box-session row id) and forwards a REMOTE parent
  (`{ sessionId, url, token }`) into the box's own `agent_start`
  (`session-spawn.ts`'s `bootSandboxAgentSession`). The box stores it on its
  row as `remoteParent` (`SessionDescriptor.remoteParent`) instead of
  `parentSessionId`. The TOKEN is a secret, so it never lands on the
  descriptor: the box keeps it in an in-memory map keyed by the session id
  (`parent-relay.ts`'s `rememberRelayToken`), and the persisted row carries
  only `{ sessionId, url }`. Nothing about the token is persisted on the
  box: a box session does not outlive its box daemon, and a restarted box
  session gets a FRESH token from the host's restart path (below). A box
  row restored without one makes `message_parent` fail with a clear "relay
  token lost after restart" instead of posting an unauthenticated report.
  `remoteParent` is DAEMON-INTERNAL on `agent_start`: only a root-gateway
  caller (the host daemon booting the box) may set it; a session caller is
  refused, and a cron/routine `kind:"agent"` job strips it.
- **Box → host.** `message_parent` (`agent-tools.ts`) sees the remote
  parent and POSTs the envelope to the host's relay endpoint
  (`POST /relay/parent-message`) instead of looking the parent up locally. The
  payload carries the message, the kind and the urgency - never the
  recipient.
- **Host relay.** The endpoint authenticates the token, resolves the parent
  and the sender FROM THE TOKEN (never from the payload) and delivers
  through the ordinary `registry.sendMessage` path, so the parent sees a
  normal `session-message` with the same urgency/steer semantics. The
  attested sender is the host-side proxy row of the box session.

**Grant lifetime.** The host keeps only the token's SHA-256 hash, in memory
and in `parent-relay-grants.json` (mode 0600, next to the sessions
registry's state), reloaded at boot so a host daemon restart does not turn a
live (detached) box's relay into `relay_token_unknown`. A grant lives for one
hour (`PARENT_RELAY_TTL_MS`) and the window SLIDES on every successful relay
use; the unref'd sweep (`sweepParentRelayGrants`, every minute) also RENEWS a
grant while both its box session and its parent are live, REVOKES it once
either is a terminal row, and prunes expired grants. A grant is also REVOKED
when its box session or its parent ends (`sessions.ts`'s exit funnel: clean
exit, kill, crash, idle-reap, daemon shutdown), is archived or forgotten,
and when the box boot fails (`session-spawn.ts`'s boot failure paths). A
restart of the box session (`session-restart-core.ts`, both the live-box
re-attach and the fresh-box path) mints a fresh grant for the restarted row
under the same parent and forwards the remote parent again.

The relay URL is operator-provided (`AGENTPROTO_PARENT_RELAY_URL`) and must be
reachable FROM the box (item 4): without it nothing is forwarded and the
box's `message_parent` keeps today's clear "no recorded parent" error. The
PULL channel (the box queues, the host drains over the provider channel) is
NOT implemented yet - it is the answer for a box that cannot reach the host
at all.

Until the PULL channel lands, a box session can report to a host parent only
when the host's relay URL is reachable from the box; the host-side rows are
still correct either way (the host can drive the box session and receives
its crash notices), and the lineage handover above works normally for
sessions that live in the SAME registry.
