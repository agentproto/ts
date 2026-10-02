/**
 * Real verdict fixtures drawn from the `kill-idle-sessions` cron prototype's
 * shared log (`.plans/session-steward-cron/SESSIONS-LOG.md`, the "Retours
 * steward" blocks). Each case carries:
 *
 *   - `expected` — the ground-truth verdict a human/the operator consensus
 *     reached in the log (NOT what Jev answered — several of these are the
 *     exact cases Jev got wrong);
 *   - `v1` — the OLD `session_evidence` shape (identity, liveness flags,
 *     worktree PR, truncated turns) the judge used before PR 3;
 *   - `v2` — the ENRICHED shape (origin, outcome, `lastToolCall`,
 *     `toolStats`, tokens, `lastTurnError`, live children, …).
 *
 * These are data, not code: the agreement test scores a deterministic,
 * criteria-faithful stub over each shape and reports the before/after rate.
 * They are not a claim about Jev's live accuracy — Jev is not callable in
 * CI — but a regression harness that keeps the concrete signals in the
 * rewritten criteria honest.
 */

export type Verdict = "done" | "abandoned" | "blocked" | "needs-input" | "active"

export interface VerdictFixture {
  id: string
  /** Where in SESSIONS-LOG.md the case comes from. */
  source: string
  expected: Verdict
  why: string
  /** The old-shape evidence. */
  v1: Record<string, unknown>
  /** The enriched evidence. */
  v2: Record<string, unknown>
}

const REPORT_TAIL =
  "## Passe 06:02 — killed: sess_5e49f370, sess_d25263d4 (agent_kill reason:completed) | nudged: aucun | " +
  "relabelled: aucun | duress RAM 0.8% | Telegram: 0"

export const VERDICT_FIXTURES: VerdictFixture[] = [
  {
    id: "cron-steward-finished-report",
    source: "SESSIONS-LOG 06:02 / 07:05 — sess_69f55fd6, sess_d707dc60",
    expected: "done",
    why:
      "A cron steward run that delivered its full pass report and closed itself; Jev re-rated it active 0.93-0.97 for five passes (false active).",
    v1: {
      sessionId: "sess_69f55fd6",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 20,
      signals: { lastAssistantTail: REPORT_TAIL, worktreeMerged: false },
      worktree: null,
      turns: [{ role: "assistant", text: REPORT_TAIL }],
    },
    v2: {
      sessionId: "sess_69f55fd6",
      origin: "cron:cron_kill-idle-sessions",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 20,
      lastToolCall: { tool: "agentproto_message_parent", kind: "done", command: "kind done" },
      turns: [{ role: "assistant", text: REPORT_TAIL }],
    },
  },
  {
    id: "w-d-docs-merged",
    source: "SESSIONS-LOG 03:18/03:48 — sess_1b1cd639 (W-D mcp-events docs)",
    expected: "done",
    why: "PR #1675 auto-merged; the work was finished before the kill.",
    v1: {
      sessionId: "sess_1b1cd639",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 40,
      signals: { worktreeMerged: true, lastAssistantTail: "PR #1675 Auto-merge success" },
      worktree: { pr: { state: "merged", number: 1675 } },
      turns: [{ role: "assistant", text: "PR #1675 Auto-merge success, W-D entirely done" }],
    },
    v2: {
      sessionId: "sess_1b1cd639",
      origin: null,
      parentSessionId: "sess_parent",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 40,
      pullRequests: { opened: 1, merged: 1, state: "merged" },
      outcome: { status: "produced", verdict: "done" },
      worktree: { pr: { state: "merged", number: 1675 } },
      turns: [{ role: "assistant", text: "PR #1675 Auto-merge success, W-D entirely done" }],
    },
  },
  {
    id: "w-e-open-pr-final-report",
    source: "SESSIONS-LOG 05:01 — sess_b9431e9b (W-E mcp-events e2e)",
    expected: "done",
    why:
      "Delivery complete: push OK, PR #1673 OPEN + CI green, final report; Jev needed a second call with enriched evidence to reach done 0.83.",
    v1: {
      sessionId: "sess_b9431e9b",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 55,
      signals: { worktreeMerged: false, lastAssistantTail: "livraison déjà complète, push OK, PR #1673 OPEN + CI verte" },
      worktree: { pr: { state: "open", number: 1673 } },
      turns: [{ role: "assistant", text: "livraison déjà complète, push OK, PR #1673 OPEN + CI verte, rien à faire de plus" }],
    },
    v2: {
      sessionId: "sess_b9431e9b",
      origin: null,
      parentSessionId: "sess_parent",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 55,
      pullRequests: { opened: 1, merged: 0, state: "open" },
      outcome: { status: "produced", verdict: "done" },
      worktree: { pr: { state: "open", number: 1673 } },
      turns: [{ role: "assistant", text: "livraison déjà complète, push OK, PR #1673 OPEN + CI verte, rien à faire de plus" }],
    },
  },
  {
    id: "phase1-commit-report",
    source: "SESSIONS-LOG 04:15 — sess_96077166 (Phase 1 exec)",
    expected: "done",
    why: "Phase 1 commit + report done; relabelled agent_kill completed.",
    v1: {
      sessionId: "sess_96077166",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 30,
      signals: { worktreeMerged: false, lastAssistantTail: "Phase1 commit 9b78aa14, report done" },
      worktree: null,
      turns: [{ role: "assistant", text: "Phase1 commit 9b78aa14, report done" }],
    },
    v2: {
      sessionId: "sess_96077166",
      origin: null,
      parentSessionId: "sess_parent",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 30,
      lastToolCall: { tool: "message_parent", kind: "done", command: "git commit -m done" },
      outcome: { status: "produced", verdict: "done" },
      turns: [{ role: "assistant", text: "Phase1 commit 9b78aa14, report done" }],
    },
  },
  {
    id: "chat-awaiting-operator",
    source: "SESSIONS-LOG 05:25/07:40 — sess_ee99c16f (sandbox humidity, operator)",
    expected: "needs-input",
    why: "Waiting on the operator's decision; Jev 0.92-0.94 needs-input but it is not killable.",
    v1: {
      sessionId: "sess_ee99c16f",
      status: "running",
      busy: false,
      awaitingInput: true,
      idleMinutes: 35,
      signals: { lastAssistantTail: "Quelle option préfères-tu ?" },
      worktree: null,
      turns: [{ role: "assistant", text: "Quelle option préfères-tu ?" }],
    },
    v2: {
      sessionId: "sess_ee99c16f",
      origin: "chat-starter",
      status: "running",
      busy: false,
      awaitingInput: true,
      idleMinutes: 35,
      lastToolCall: { tool: "message_parent", command: "needs-input" },
      turns: [{ role: "assistant", text: "Quelle option préfères-tu ?" }],
    },
  },
  {
    id: "chat-question-no-flag",
    source: "SESSIONS-LOG 14:09 — sess_d5eeaf3a (chat 14:09)",
    expected: "needs-input",
    why: "Last agent turn is a question to the operator (Jev 0.94).",
    v1: {
      sessionId: "sess_d5eeaf3a",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 25,
      signals: { lastAssistantTail: "…" },
      worktree: null,
      turns: [],
    },
    v2: {
      sessionId: "sess_d5eeaf3a",
      origin: "chat-starter",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 25,
      minutesSinceUserMessage: 40,
      minutesSinceAgentMessage: 25,
      turns: [{ role: "assistant", text: "Veux-tu que je pousse la PR maintenant ?" }],
    },
  },
  {
    id: "empty-chat-never-ran",
    source: "SESSIONS-LOG 04:42/12:25 — sess_68755588, sess_80907e1f (0 tokens)",
    expected: "abandoned",
    why: "Chat session with 0 messages and 0 tokens — never ran; trivial, no judge needed.",
    v1: {
      sessionId: "sess_80907e1f",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 50,
      signals: {},
      worktree: null,
      turns: [],
    },
    v2: {
      sessionId: "sess_80907e1f",
      origin: "chat-starter",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 50,
      tokensIn: 0,
      tokensOut: 0,
      turns: [],
    },
  },
  {
    id: "review-cut-mid-work",
    source: "SESSIONS-LOG 03:44 — sess_92f5fbda (review:correctness)",
    expected: "abandoned",
    why: "Cut off mid-work at 01:45; the transcript tail is an unfinished code block, no conclusion.",
    v1: {
      sessionId: "sess_92f5fbda",
      status: "killed",
      busy: false,
      awaitingInput: false,
      idleMinutes: 120,
      signals: { lastAssistantTail: "```ts\nconst x = " },
      worktree: null,
      turns: [{ role: "assistant", text: "```ts\nconst x = " }],
    },
    v2: {
      sessionId: "sess_92f5fbda",
      origin: "gate",
      status: "killed",
      busy: false,
      awaitingInput: false,
      idleMinutes: 120,
      outcome: { status: "produced", verdict: "partial" },
      turns: [{ role: "assistant", text: "```ts\nconst x = " }],
    },
  },
  {
    id: "loop-exploration",
    source: "SESSIONS-LOG 02:55 — sess_1b1cd639 (W-D loop)",
    expected: "active",
    why:
      "A verbatim exploration loop (rg … | head -10 x6); healed by an interrupt, never a kill. Still mid-work.",
    v1: {
      sessionId: "sess_1b1cd639",
      status: "running",
      busy: true,
      awaitingInput: false,
      idleMinutes: 0,
      signals: { lastAssistantTail: "le fichier est peut-être ailleurs" },
      worktree: null,
      turns: [{ role: "assistant", text: "le fichier est peut-être ailleurs" }],
    },
    v2: {
      sessionId: "sess_1b1cd639",
      origin: null,
      parentSessionId: "sess_parent",
      status: "running",
      busy: true,
      awaitingInput: false,
      idleMinutes: 0,
      toolStats: {
        total: 40,
        distinct: 4,
        repeated: 36,
        ratio: 0.1,
        topCommand: "Bash rg -rn sentinel packages/runtime/docs/mcp-tools/agent_start.md | head -10",
        topCommandCount: 6,
        distinctReads: 1,
        repeatedReads: 6,
      },
      turns: [{ role: "assistant", text: "le fichier est peut-être ailleurs" }],
    },
  },
  {
    id: "watchdog-polling",
    source: "SESSIONS-LOG 07:40/13:30 — sess_ae609c39, sess_955dd843 (gh pr polling)",
    expected: "active",
    why: "A legitimate `gh pr view` watch poll (x22) — busy, progressing, never a loop.",
    v1: {
      sessionId: "sess_ae609c39",
      status: "running",
      busy: true,
      awaitingInput: false,
      idleMinutes: 0,
      signals: { lastAssistantTail: "watch polling" },
      worktree: { pr: { state: "open", number: 1673 } },
      turns: [{ role: "assistant", text: "watch polling" }],
    },
    v2: {
      sessionId: "sess_ae609c39",
      origin: "chat-starter",
      status: "running",
      busy: true,
      awaitingInput: false,
      idleMinutes: 0,
      toolStats: {
        total: 30,
        distinct: 2,
        repeated: 28,
        ratio: 0.07,
        topCommand: "Bash gh pr view 1673",
        topCommandCount: 22,
        distinctReads: 0,
        repeatedReads: 0,
      },
      turns: [{ role: "assistant", text: "watch polling" }],
    },
  },
  {
    id: "supervisor-waiting-children",
    source: "SESSIONS-LOG 12:25 — sess_5006798b (pyg-cos2-supervisor, keepAlive)",
    expected: "blocked",
    why: "A supervisor waiting on its live child (keepAlive + one live child); not killable.",
    v1: {
      sessionId: "sess_5006798b",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 30,
      keepAlive: true,
      signals: { parentEnded: false, lastAssistantTail: "waiting on child" },
      worktree: null,
      turns: [{ role: "assistant", text: "waiting on child 0d52111f" }],
    },
    v2: {
      sessionId: "sess_5006798b",
      origin: "cron:pyg-cos2",
      status: "running",
      busy: false,
      awaitingInput: false,
      idleMinutes: 30,
      keepAlive: true,
      liveChildren: 1,
      turns: [{ role: "assistant", text: "waiting on child 0d52111f" }],
    },
  },
]
