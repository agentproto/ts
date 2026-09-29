# AIP-7 amendment draft: the runtime approval request

Status: draft, written by the E1a lane (`.plans/pygmalion/lanes/E1a.md`).
Not a spec change until the maintainer accepts it — this documents what
`packages/runtime/src/approvals/` actually built and why, so the amendment
can be reviewed against real code instead of a proposal in the abstract.

## 1. What AIP-7 already gives us

`packages/governance/core/AGENTGOVERNANCE.md` §2 defines `signature` as
"the universal approval primitive": a `documentHash` pinning exact bytes, a
`signerKind` (`user` vs `agent` vs others), four `method`s (one of them,
`click_through`, is a one-shot-token human click), and §3's hash-chained
`audit-event` log. `packages/governance/engine`'s `signArtifact` +
`recordAuditEvent` are the reference implementation. Before this lane nothing
in the daemon runtime called either.

## 2. What this lane adds: the runtime approval request

An `ApprovalRequest` is NOT a new doctype — it's the daemon's own in-memory +
on-disk record (`packages/runtime/src/approvals/types.ts`) that wraps an
AIP-7 signature as its approve outcome. The pieces:

- **Identity/content**: `id`, `kind`, `title`, `preview` (opaque JSON for a
  UI), and a `payload` written as canonical JSON to
  `<approvalsHome>/<id>/payload.json` — `payloadHash` is its sha256. This is
  the thing `signArtifact` actually signs (`artifactPath` = that same file);
  the signature's `documentHash` and the request's `payloadHash` are
  therefore always the same value by construction, not by convention.
- **State**: `pending → approved | denied | expired`, `approved → consumed`.
  Lazy expiry (`checkExpiry` in `engine.ts`) — no background sweep; a
  `pending` record whose `expiresAt` has passed flips the next time
  anything reads or decides it.
- **Persistence**: atomic write-tmp+rename (mirrors `task-ledger.ts` /
  `agentproto-dir.ts`), reloaded at boot from `<approvalsHome>/<id>/` —
  a restart never loses a pending request, and a decided/consumed one keeps
  its state.

## 3. Human channels — the part AIP-7 didn't specify

AIP-7 defines signing METHODS (`click_through`, `typed_name`, …) but not
WHO may trigger one or how a runtime enforces "only a human". This lane's
answer: a channel is a concrete, closed mechanism the runtime itself gates,
never a model-callable tool.

- **`web_click`**: `POST /approvals/:id/decision`. Gated by BOTH the
  daemon's per-boot bearer token AND an `Origin` header present in
  `approvals.webOrigins` (config, default empty = channel off). Evidence's
  `signedUrlToken` is a fresh random nonce per decision.
- **`ui_card`** (MCP Apps): the card is a `ui://agentproto/approval/<id>`
  resource whose HTML PRODUCER (not the registration) mints a fresh
  one-time ticket on every `resources/read` — 32 random bytes base64url,
  stored hashed, 10-minute TTL, and minting again supersedes whatever
  ticket that approval had. The card's buttons call
  `approval_card_decide {approvalId, decision, ticket}`, an MCP tool whose
  DEFINITION carries `_meta.ui.visibility: ["app"]` (via `toMcpTool`) — a
  host that filters `tools/list` for what it shows its model ("drop
  anything whose visibility doesn't include `model`") never offers it as a
  callable action. The ticket is checked with a constant-time compare and
  burned on any attempt (valid or not) so a wrong guess kills the real one
  too. Evidence's `signedUrlToken` holds the ticket's hash, not the raw
  ticket — the raw value never touches the audit log or the signature file.

Either way, an approve calls `signArtifact` (`signerKind: "user"`,
`signer: "user:local"`, `method: "click_through"`) on `payload.json`; a
deny calls `recordAuditEvent` directly with no signature. Both append to
the same hash-chained `audit/audit-log.jsonl` under `approvalsHome`.

## 4. The rule: agents never decide

Every model-visible tool this lane ships (`approval_request`,
`approval_get`, `approval_wait`, `approval_consume`) can only create and
read pending state or, once a human decided, atomically consume it once.
None of them can flip `pending → approved|denied`. The one tool that CAN
(`approval_card_decide`) is deliberately built so a host has to go out of
its way to expose it to a model — see §3. Nothing from
`@agentproto/governance-engine`'s own tool surface (`sign_artifact`,
`request_signatures`, `list_pending_signatures`, `record_audit_event`) is
mounted anywhere a session can reach; this lane calls those functions
directly from inside the engine, never as tools.

## 5. Card threat model and its residual risk

The `ui_card` channel's security rests on one assumption: **the ticket
never appears anywhere a model can read it** — not in `approval_request` /
`approval_get` / `approval_wait` / `approval_consume`'s results (verified
by `approvals-ticket-secrecy.test.ts`), not in `approval_card_decide`'s own
tool DEFINITION (only its per-call `arguments`, which is exactly where the
card's own inline JS puts it), and not anywhere durable a session's
transcript would capture except the one HTML document the ticket was
minted for.

**Residual risk, stated plainly**: if an MCP Apps HOST lets its own model
read a `ui://` resource's contents via `resources/read` (as opposed to only
RENDERING it in a sandboxed iframe the model never sees), the ticket leaks
to the model the moment the card is displayed — `_meta.ui.visibility` on
the DECIDE TOOL doesn't protect the ticket if the RESOURCE itself is
model-readable. AIP-7 / the ext-apps spec this lane leans on
(`io.modelcontextprotocol/ui 2026-01-26`, see `register-ui-resource.ts`'s
header) treats `ui://` resources as host-rendered UI, not model context —
but that's a host CONVENTION, not something this lane's code can enforce
from the server side.

**This residual risk turned out to be real, not hypothetical**: agent CLIs
(Claude Code confirmed; likely others) do NOT honour `_meta.ui.visibility`
and DO give their model a generic `resources/read` tool plus the ability to
call any registered tool by name, `approval_card_decide` included. Mounted
on the same `/mcp` surface a daemon-spawned agent session connects to, the
card was self-servable: the agent could read its own approval's card,
extract the ticket, and call `approval_card_decide` itself. The fix is
server-side, not a host convention: `approval_card_decide` and every
`ui://agentproto/approval/<id>` resource are now registered ONLY on a
dedicated `?surface=approval-cards` MCP connection (`index.ts`'s
`mcpServerFactory`, gated in `http-server.ts`'s `handleMcp`), and that
connection is refused outright (403) whenever it carries a
`callerSessionId` (the daemon-spawned-session identity marker) — so no
agent-CLI self-ref connection can ever reach either. The root `/mcp` (a
human driving the daemon directly, or a client that never identified
itself) keeps `approval_request`/`get`/`wait`/`consume` but never gets the
decide tool or the resources.

**What the fix does NOT cover — stated plainly**:
- **The card surface is safe only on a host that actually behaves like a
  human-facing MCP Apps host**: renders `ui://` resources in a sandboxed
  surface the model never reads, and does not hand its model a generic
  `resources/read` or an unfiltered `tools/call` reaching app-only tools.
  Claude Desktop configured via `install-mcp --app` is the intended such
  host; **whether it actually holds this line is UNVERIFIED by this
  lane** — we found no documented guarantee either way and had no way to
  check it empirically from here. Anything pointed at `?surface=approval-cards`
  should be verified against this before being trusted for anything
  higher-stakes than convenience gating.
- **The local-token residual**: `?surface=approval-cards` carries no
  credential of its own beyond whatever already gates `/mcp` (loopback
  trust, or the daemon's bearer token in `mode: "bearer"`). Anything that
  already holds that token, or already runs on the loopback host with
  daemon-mode `"none"`, can open the card surface directly and reach
  `approval_card_decide` — the surface split defends against an *agent
  session's own self-ref connection* reaching the card, not against a
  process that independently holds daemon-level access. That is the same
  trust boundary every other `/mcp` tool sits behind today; this lane does
  not widen or narrow it.

## 6. Follow-ups (explicitly out of scope for E1a)

- **Migrate the three older mechanisms onto this primitive**: `policy_ack`
  (git-commit acks, `supervisor.ts`), held permissions
  (`sessions.ts`'s in-memory approve/deny), and workflow `kind:"approval"`
  steps (`workflow-runner.ts`, free-text `who`, auto-approves with no
  approver hook). Each currently proves nothing about a human deciding;
  routing them through `ApprovalsEngine.decideWeb`/`decideByCard` would
  close that gap for all three at once instead of three times over.
- **Hide `policy_ack` from sessions** — today it's callable on the root
  `/mcp` by any caller (`index.ts:2323` at the time `ARCHI-OPTIONS.md` was
  written); once policy acks route through this engine, the raw verb
  should stop being session-reachable.
- **The task board link (E1b)** — `taskId` rides on every request and every
  `approval:*` event today but nothing reads it back. E1b wires
  `awaiting_approval`, `approvalIds`, and the `approval:decided` →
  `in_progress`/`cancelled` transition into `task-ledger.ts`.
- **`phone_button` / `signed_link` channels** — the `ApprovalChannel` union
  and the `channels` field on every request are already shaped to add
  more declared human channels later without touching the state machine;
  neither is built here.
- **Multi-user** — `signer: "user:local"` is hardcoded. A real multi-user
  deployment needs the decision routes to carry an actual signer identity
  instead of a single local placeholder.
