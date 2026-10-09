// Mechanical session-health rules, ported from the `kill-idle-sessions`
// cron prototype (`.plans/session-steward-cron/SESSIONS-LOG.md`, rules 1-9 +
// the three "Retours steward" dogfood blocks). Each rule here is a PURE
// function over data the workflow already gathers — `session_list`
// descriptors, `tool_calls_list` records, `host_load`, `app_state` events —
// with no I/O, no clock read, no daemon state, so a unit test pins it
// exactly. `entry.mjs` (the WORKFLOW.md step graph) wires them; the LLM/Jev
// judge only sees what stays ambiguous after these rules have spoken.
//
// Safety shape (mirrors origin-policy.mjs):
//   - a `looping` session is NEVER closed — the proposed action is a nudge
//     interrupt, and only ever a PROPOSAL in the report;
//   - a stall proposes a "continue" nudge, never a close;
//   - at most ONE nudge proposal per session per pass;
//   - the proposed actions are reported in dry run exactly as in apply —
//     `apply` never changes what these pure functions decide, only whether
//     the report is executed elsewhere.
//
// Provenance lives in origin-policy.mjs and still wins: a user-origin
// session is reported as observed, never nudged (a human is in the loop).

// ── loop detection (mission item 1) ──────────────────────────────────────

/** Rolling window the loop signals are computed over. */
export const LOOP_WINDOW_MS = 10 * 60 * 1000
/** Same call signature (verbatim argv) this many times in the window. */
export const LOOP_VERBATIM_MIN = 3
/** Distinct/total below this, with at least {@link LOOP_RATIO_MIN_CALLS}
 *  calls, is a repetition loop. */
export const LOOP_RATIO_MAX = 0.2
export const LOOP_RATIO_MIN_CALLS = 8
/** The same file re-read this many times in the window. */
export const LOOP_REREAD_MIN = 4

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0
const str = (v) => (isNonEmptyString(v) ? v.trim() : undefined)

/** The verbatim argv signature of one `tool_calls_list` record — tool name +
 *  command + args, whitespace-collapsed. This is the "même commande relancée
 *  verbatim" signal from the log (a `rg … | head -10` repeated six times). */
export function callSignature(record) {
  const tool = str(record?.tool) ?? "unknown"
  const command = str(record?.command)
  const args = Array.isArray(record?.args) ? record.args.map(String) : []
  const tail = args.length > 0 ? args.join(" ") : ""
  return `${tool} ${command ?? ""} ${tail}`.replace(/\s+/g, " ").trim()
}

/**
 * Command families the log explicitly calls USEFUL loops, not stuck ones:
 * `watch`, a test/type-check re-run, `git status` between steps, and a
 * `gh pr view`/`checks` watch poll. Their repeats are excluded from the
 * repetition signals, so a watchdog polling PR state for ten minutes is not
 * flagged as a loop (SESSIONS-LOG: "watch polling legitime", "tests re-run").
 */
export function isUsefulLoopCommand(signature) {
  const s = String(signature ?? "").toLowerCase()
  if (/(^|[^a-z])watch([^a-z]|$)/.test(s)) return true
  if (/(^|[^a-z])git\s+status([^a-z]|$)/.test(s)) return true
  if (/(pnpm|npm|yarn|npx|bun)\s+(run\s+)?(test|vitest|jest|mocha|check-types|typecheck|build|gate)\b/.test(s)) return true
  if (/(^|[^a-z])(vitest|jest|mocha)([^a-z]|$)/.test(s)) return true
  if (/(^|[^a-z])gh\s+pr\s+(view|checks|status|list|watch)\b/.test(s)) return true
  return false
}

const READ_TOOLS = new Set(["read", "cat", "rg", "grep", "sed", "head", "tail", "less", "view", "readfile"])
const FILE_EXT = /\.(md|ts|tsx|js|mjs|cjs|json|txt|py|go|rs|sql|yml|yaml|toml|log|sh)$/
const READ_VERB_WORD = /^["']?(cat|rg|grep|sed|head|tail|less|view)["']?$/

/**
 * The file a read-like call targeted, or `null`. Best-effort: an in-agent
 * `Read` call records no shell command (see tool-call-record.ts), so this
 * only resolves for shell-shaped reads (`cat`, `rg`, `sed`, …). Absence is
 * not an error — it just means this call contributes no read-target signal.
 */
export function readTargetOf(record) {
  const tool = String(record?.tool ?? "").toLowerCase()
  const command = str(record?.command)
  const args = Array.isArray(record?.args) ? record.args.map(String) : []
  const readTool = READ_TOOLS.has(tool)
  if (!readTool && command === undefined) return null
  // A shell line is several commands: only a segment that STARTS with a read
  // verb reads a file. `cd <dir> &&`, `git log | head` and `--grep=…` do not.
  const segments = command !== undefined && !readTool ? command.split(/&&|\|\||\||;/) : [undefined]
  for (const seg of segments) {
    let tokens = seg !== undefined ? seg.trim().split(/\s+/) : command !== undefined ? command.split(/\s+/) : args
    let searchVerb = tool === "rg" || tool === "grep"
    if (seg !== undefined) {
      const first = tokens.findIndex((t) => !t.includes("=") || t.startsWith("-"))
      if (first < 0 || !READ_VERB_WORD.test(tokens[first])) continue
      searchVerb = /^["']?(rg|grep)["']?$/.test(tokens[first])
      tokens = tokens.slice(first + 1)
    }
    // `rg`/`grep` take a pattern first, then search roots: the pattern is not
    // a file, and a root without an extension is a directory (a recursive
    // search of one tree is not "the same file re-read").
    let patternPending = searchVerb
    for (const raw of tokens) {
      const t = raw.replace(/^['"]|['"]$/g, "")
      if (!t || t.startsWith("-") || t.includes("=")) continue
      if (patternPending) {
        patternPending = false
        continue
      }
      if (searchVerb) {
        if (FILE_EXT.test(t)) return t
        continue
      }
      if (t.includes("/") || FILE_EXT.test(t)) return t
    }
    if (seg === undefined) return args[0] ?? null
  }
  return null
}

function topEntry(counts) {
  let best = null
  for (const [key, n] of counts) if (best === null || n > best.count) best = { key, count: n }
  return best
}

/**
 * Detect a repetition loop from one session's recent tool calls. `looping`
 * when, inside `windowMs`:
 *   - the same call signature appears verbatim ≥ `verbatimMin`; OR
 *   - distinct/total < `ratioMax` over at least `ratioMinCalls` calls; OR
 *   - the same file is read ≥ `rereadMin` times.
 * Useful-loop command families are excluded from the counts first (see
 * {@link isUsefulLoopCommand}), so a watchdog poll or a test re-run never
 * trips it. Returns the stats either way, so the report can show its work.
 */
export function detectLoop(records, opts = {}) {
  const nowMs = opts.nowMs ?? 0
  const windowMs = opts.windowMs ?? LOOP_WINDOW_MS
  const verbatimMin = opts.verbatimMin ?? LOOP_VERBATIM_MIN
  const ratioMax = opts.ratioMax ?? LOOP_RATIO_MAX
  const ratioMinCalls = opts.ratioMinCalls ?? LOOP_RATIO_MIN_CALLS
  const rereadMin = opts.rereadMin ?? LOOP_REREAD_MIN

  const inWindow = (Array.isArray(records) ? records : []).filter((r) => {
    const ts = Date.parse(r?.ts)
    return Number.isFinite(ts) && ts <= nowMs + 1000 && nowMs - ts <= windowMs
  })
  // A record with no command and no args (an in-agent `read`/`edit` call) has
  // nothing but its tool name to compare, so three of them in ten minutes is
  // normal work, not a loop — leave it out of every repetition signal.
  const informative = inWindow.filter((r) => str(r?.command) !== undefined || (Array.isArray(r?.args) && r.args.length > 0))
  const calls = informative.filter((r) => !isUsefulLoopCommand(callSignature(r)))
  const counts = new Map()
  const reads = new Map()
  for (const r of calls) {
    const sig = callSignature(r)
    counts.set(sig, (counts.get(sig) ?? 0) + 1)
    const target = readTargetOf(r)
    if (target) reads.set(target, (reads.get(target) ?? 0) + 1)
  }
  const total = calls.length
  const distinct = counts.size
  const ratio = total > 0 ? distinct / total : 1
  const maxVerbatim = topEntry(counts)?.count ?? 0
  const maxReads = topEntry(reads)?.count ?? 0
  const top = topEntry(counts)

  const reasons = []
  if (maxVerbatim >= verbatimMin) reasons.push(`same call verbatim x${maxVerbatim} in ${Math.round(windowMs / 60_000)}m`)
  if (total >= ratioMinCalls && ratio < ratioMax) reasons.push(`distinct/total ${distinct}/${total} < ${ratioMax}`)
  if (maxReads >= rereadMin) reasons.push(`same file read x${maxReads}`)

  return {
    looping: reasons.length > 0,
    reasons,
    stats: {
      windowMs,
      total,
      distinct,
      ratio: Math.round(ratio * 100) / 100,
      maxVerbatim,
      maxReads,
      usefulExcluded: informative.length - total,
      anonymousExcluded: inWindow.length - informative.length,
      topCommand: top ? top.key : null,
      topCommandCount: top ? top.count : 0,
    },
  }
}

// ── stall (mission item 2) ───────────────────────────────────────────────

/** Busy this many minutes with no new activity is a stall. */
export const STALL_BUSY_MINUTES = 20
/** A turn error younger than this, on an idle process, is a stall. */
export const STALL_ERROR_RECENT_MINUTES = 30

/**
 * A stall is either (a) busy longer than {@link STALL_BUSY_MINUTES} with no
 * new activity, or (b) a recent `lastTurnErroredAt` on a process that is NOT
 * busy (the turn already ended in an error; a "continue" restarts it). The
 * proposed action is a single "continue" nudge — never a close.
 */
export function detectStall(input = {}) {
  const nowMs = input.nowMs ?? 0
  const busyMinutes = input.busyStallMinutes ?? STALL_BUSY_MINUTES
  const errorRecentMinutes = input.errorRecentMinutes ?? STALL_ERROR_RECENT_MINUTES
  const idle = typeof input.idleMinutes === "number" && Number.isFinite(input.idleMinutes) ? input.idleMinutes : undefined
  if (input.busy === true && idle !== undefined && idle > busyMinutes) {
    return { stalled: true, kind: "busy", reason: `busy ${Math.round(idle)}min > ${busyMinutes}min without new activity` }
  }
  const errTs = input.lastTurnErroredAt ? Date.parse(input.lastTurnErroredAt) : Number.NaN
  if (Number.isFinite(errTs)) {
    const ageMin = (nowMs - errTs) / 60_000
    if (ageMin >= 0 && ageMin <= errorRecentMinutes && input.busy !== true) {
      return { stalled: true, kind: "error", reason: `turn errored ${Math.round(ageMin)}min ago and process idle` }
    }
  }
  return { stalled: false, kind: null, reason: null }
}

// ── never-ran (mission item 3) ───────────────────────────────────────────

const minutesSince = (ts, nowMs) => {
  const ms = ts ? Date.parse(ts) : Number.NaN
  return Number.isFinite(ms) ? (nowMs - ms) / 60_000 : undefined
}

/**
 * A session that never actually ran: explicit 0 in AND 0 out. `undefined`
 * tokens (not reported) is NOT "never ran" — only a hard 0/0 is. A session
 * that is busy, still starting/provisioning, or has a prompt queued for its
 * first turn is merely young, not stuck. With `opts.nowMs`, the session must
 * also be at least `opts.idleMinutes` old (`startedAt`) AND idle
 * (`lastActivityAt`, else `startedAt`); an absent timestamp does not block.
 */
export function isNeverRan(session, opts = {}) {
  if (!(session?.tokensIn === 0 && session?.tokensOut === 0)) return false
  if (session.busy === true || session.status === "starting" || session.provisioning) return false
  if (Array.isArray(session.pendingPrompts) && session.pendingPrompts.length > 0) return false
  if (typeof opts.nowMs === "number") {
    const threshold = opts.idleMinutes ?? 0
    const age = minutesSince(session.startedAt, opts.nowMs)
    const idle = minutesSince(session.lastActivityAt ?? session.startedAt, opts.nowMs)
    if (age !== undefined && age < threshold) return false
    if (idle !== undefined && idle < threshold) return false
  }
  return true
}

// ── fast-path done (mission item 4) ──────────────────────────────────────

/** A tool-call record whose tool name is a `message_parent` call. */
export function isMessageParentCall(record) {
  const tool = String(record?.tool ?? "").toLowerCase()
  return tool.includes("message_parent")
}

/** A `message_parent` call carrying `kind: "done"` in any of the shapes a
 *  record can expose it (tool name, command, args, or an explicit `kind`). */
export function isDoneMessageParent(record) {
  if (!isMessageParentCall(record)) return false
  const blob = `${record?.kind ?? ""} ${record?.command ?? ""} ${Array.isArray(record?.args) ? record.args.join(" ") : ""}`.toLowerCase()
  return /(^|[^a-z])done([^a-z]|$)/.test(blob) || record?.kind === "done"
}

/** A call that commits or opens a PR — the second half of the done fast-path. */
export function isCommitOrPrCall(record) {
  if (record?.createdPrUrl || typeof record?.createdPrNumber === "number") return true
  const tool = String(record?.tool ?? "").toLowerCase()
  if (tool.includes("git_commit") || tool.includes("create_pull_request") || tool.includes("pr_create")) return true
  const command = String(record?.command ?? "").toLowerCase()
  return /\bgit\s+commit\b/.test(command) || /\bgh\s+pr\s+create\b/.test(command)
}

/**
 * The done fast-path: the last tool call is `message_parent(kind:done)` AND
 * the window shows a commit/PR (or a MERGED worktree PR or the derived
 * outcome already proves one). That is `done` without spending a judge.
 * Anything short of both halves returns `{ done: false }`.
 */
export function detectFastPathDone(input = {}) {
  const calls = Array.isArray(input.toolCalls) ? input.toolCalls : []
  const last = input.lastToolCall ?? (calls.length > 0 ? calls[calls.length - 1] : null)
  const doneMessage = isDoneMessageParent(last) || calls.some(isDoneMessageParent)
  if (!doneMessage) return { done: false, reason: "no message_parent(kind:done)" }
  const prState = input.worktree?.pr?.state
  const merged = prState === "merged" || prState === "MERGED"
  const outcomePrs = Array.isArray(input.outcome?.pullRequests) ? input.outcome.pullRequests.length : 0
  // An OPEN worktree PR is work awaiting review, not proof of completion.
  const hasCommitOrPr = calls.some(isCommitOrPrCall) || merged || outcomePrs > 0
  if (!hasCommitOrPr) return { done: false, reason: "message_parent(kind:done) but no commit/PR" }
  return { done: true, reason: merged || outcomePrs > 0 ? "message_parent(kind:done) + merged/opened PR" : "message_parent(kind:done) + commit" }
}

// ── terminal sessions without an outcome (mission item 5) ────────────────

const TERMINAL_STATUSES = new Set(["killed", "exited", "error", "stopped", "completed", "failed"])

/** PR numbers a `session_list` row records: `openedPrs[].number` plus the
 *  `outcome.artifacts` `pr` entries (`#N` title or a `…/pull/N` ref). Sorted,
 *  de-duplicated. */
export function prNumbersOf(session) {
  const nums = new Set()
  for (const pr of Array.isArray(session?.openedPrs) ? session.openedPrs : []) {
    if (Number.isInteger(pr?.number)) nums.add(pr.number)
  }
  for (const a of Array.isArray(session?.outcome?.artifacts) ? session.outcome.artifacts : []) {
    if (a?.type !== "pr") continue
    const m = /#(\d+)$/.exec(String(a.title ?? "")) ?? /\/pull\/(\d+)/.exec(String(a.ref ?? ""))
    if (m) nums.add(Number(m[1]))
  }
  return [...nums].sort((a, b) => a - b)
}

/** Relabel verdict for "no positive evidence either way". */
export const UNKNOWN_VERDICT = "unknown"
/** Relabel verdict for "a PR/outcome exists but work remains" (report only —
 *  the steward never closes on it, and a terminal session has nothing to flag). */
export const FOLLOW_UP_VERDICT = "needs-follow-up"

const isMergedState = state => state === "merged" || state === "MERGED"
const isOpenState = state => state === "open" || state === "OPEN"

/** `owner/repo` out of a GitHub PR URL; undefined when it names no repo. */
export function repoOfPrUrl(url) {
  const m = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+/.exec(String(url ?? ""))
  return m ? m[1] : undefined
}

/** `owner/repo#N` when the repo is known, else `#N` — a bare number is
 *  ambiguous across repos (G3: `#504` was agentik-studio's, not agentproto's). */
export const fmtPr = (n, repo) => (repo ? `${repo}#${n}` : `#${n}`)
const fmtPrs = (nums, repos) => nums.map(n => fmtPr(n, repos?.[n])).join(", ")

/** owner/repo per PR number from the session's `outcome.artifacts` PR refs
 *  (`…github.com/OWNER/REPO/pull/N`) — the only list-row field that carries
 *  a repo. Plain object (journal-safe). */
export function prReposOf(session) {
  const repos = {}
  for (const a of Array.isArray(session?.outcome?.artifacts) ? session.outcome.artifacts : []) {
    if (a?.type !== "pr") continue
    const m = /\/pull\/(\d+)/.exec(String(a.ref ?? ""))
    const repo = repoOfPrUrl(a.ref)
    if (m && repo) repos[Number(m[1])] = repo
  }
  return repos
}

/**
 * A terminal session that still carries no derived outcome and no wrapup
 * flag is a relabel CANDIDATE — visible instead of invisible, as the log
 * asks. A PR is never proof the session finished, so the proposal is
 * deliberately cautious: `done` only when the session's OWN record shows its
 * PR merged (a worktree PR it never recorded is shared with sibling sessions
 * and credits nobody); otherwise `unknown`. {@link refineRelabel} sharpens
 * it with evidence and runs the remaining-work check.
 */
export function terminalRelabelCandidate(session) {
  if (!TERMINAL_STATUSES.has(String(session?.status ?? ""))) return { candidate: false, reason: "not terminal" }
  if (session?.outcome?.verdict) return { candidate: false, reason: "outcome already recorded" }
  if (session?.wrapupFlag) return { candidate: false, reason: "already flagged" }
  const prs = prNumbersOf(session)
  const repos = prReposOf(session)
  const wt = session?.worktree?.pr
  if (isMergedState(wt?.state) && Number.isInteger(wt?.number) && prs.includes(wt.number)) {
    return { candidate: true, proposedVerdict: "done", reason: `PR ${fmtPr(wt.number, repos[wt.number])} merged`, prs, repos }
  }
  if (prs.length > 0) {
    return { candidate: true, proposedVerdict: UNKNOWN_VERDICT, reason: `PR${prs.length > 1 ? "s" : ""} ${fmtPrs(prs, repos)} recorded, state unknown`, prs, repos }
  }
  return { candidate: true, proposedVerdict: UNKNOWN_VERDICT, reason: "terminal, no PR recorded — outcome unknown", prs, repos }
}

/**
 * Sharpen one relabel proposal with its `session_evidence` answer.
 *  - the worktree PR is merged AND the session recorded it → `done`;
 *  - merged but NOT recorded by this session (a shared worktree) → `unknown`;
 *  - open and the session's own → `needs-follow-up` (awaiting review/merge);
 *    open and not its own → `unknown`;
 *  - no PR: `abandoned` only on positive evidence (errored / never ran).
 * Whatever lands on `done` then goes through the remaining-work check on the
 * last assistant turn: a question or announced next step → `needs-follow-up`.
 */
export function refineRelabel(item, evidence) {
  if (!evidence) return item
  const wt = evidence.worktree?.pr
  const state = wt?.state ?? null
  const known = Array.isArray(item?.prs) ? item.prs : []
  const n = Number.isInteger(wt?.number) ? wt.number : undefined
  const repos = { ...(item?.repos ?? {}) }
  const wtRepo = repoOfPrUrl(wt?.url)
  if (n !== undefined && wtRepo) repos[n] = wtRepo
  const label = n !== undefined ? fmtPr(n, repos[n]) : "PR"
  const own = n !== undefined && known.includes(n)
  let next = item
  if (isMergedState(state) && n !== undefined) {
    next = own
      ? { ...item, proposedVerdict: "done", reason: `PR ${label} merged` }
      : { ...item, proposedVerdict: UNKNOWN_VERDICT, reason: `worktree PR ${label} merged, not recorded by this session (shared worktree)` }
  } else if (isOpenState(state) && n !== undefined) {
    next = own
      ? { ...item, proposedVerdict: FOLLOW_UP_VERDICT, reason: `PR ${label} open — awaiting review/merge` }
      : { ...item, proposedVerdict: UNKNOWN_VERDICT, reason: `worktree PR ${label} open, not recorded by this session` }
  } else if ((evidence.pullRequests?.opened ?? 0) > 0) {
    const opened = evidence.pullRequests.opened
    next = { ...item, proposedVerdict: UNKNOWN_VERDICT, reason: `${opened} PR${opened > 1 ? "s" : ""} opened, state unknown` }
  } else if (item?.proposedVerdict === UNKNOWN_VERDICT) {
    if (typeof evidence.lastTurnError === "string" && evidence.lastTurnError.trim()) {
      next = { ...item, proposedVerdict: "abandoned", reason: `no PR, last turn errored: ${evidence.lastTurnError.trim().slice(0, 80)}` }
    } else if (evidence.turnsCompleted === 0) {
      next = { ...item, proposedVerdict: "abandoned", reason: "no PR, no turn ever completed" }
    }
  }
  if (Object.keys(repos).length > 0) next = { ...next, repos }
  if (next.proposedVerdict === "done") {
    const turns = Array.isArray(evidence.turns) ? evidence.turns : []
    const lastAssistant = [...turns].reverse().find(t => t?.role === "assistant")
    const pending = remainingWork({ lastAssistantText: lastAssistant?.text })
    if (pending.length > 0) {
      return { ...next, proposedVerdict: FOLLOW_UP_VERDICT, reason: `${next.reason}; remaining work: ${pending.join(", ")}` }
    }
  }
  return next
}

// ── remaining-work detection (G11) ───────────────────────────────────────
//
// A PR, a merged worktree or an ended parent says the work MOVED ON, never
// that THIS session finished: a child whose last message asks something or
// announces a next step has an orphaned obligation once its parent is gone.
// Closing it silently drops that. These checks therefore turn a would-be
// close / `done` into a FLAG; they are conservative on purpose (a false
// positive costs one flag, a false negative drops a question).

/** A `?` that ends a sentence, a quote or a bracket — not a URL query (`?a=1`). */
const QUESTION_MARK = /\?(?=\s|$|["'»”’)\]*_`])/
/** How far back from the end of the message a `?` still counts as "the
 *  question this session left open". */
const QUESTION_WINDOW_CHARS = 240

/** Deferred-work phrasing, EN + FR. `kind` names the signal in the flag note. */
const PENDING_PATTERNS = [
  { kind: "open question", re: /\b(open\s+question|unanswered|question\s+ouverte|sans\s+réponse|j'?ai\s+posé\s+la\s+question|the\s+question\s+i\s+(?:put|sent|asked))\b/i },
  { kind: "asks the user", re: /\b(should\s+i|should\s+we|shall\s+i|shall\s+we|do\s+you\s+want|would\s+you\s+like|dois-je|faut-il|je\s+corrige|voulez-vous|veux-tu)\b/i },
  { kind: "waiting", re: /\b(waiting\s+(?:for|on)|i'?ll\s+report|i\s+will\s+report|en\s+attente|j'?attends|dans\s+l'?attente)\b/i },
  { kind: "next step", re: /\b(next\s+steps?|to\s+do\s+next|follow[- ]?ups?|todo|à\s+faire|reste\s+à|prochaines?\s+étapes?|il\s+faudrait|avant\s+le\s+prochain|(?:i|we)\s+(?:still\s+)?(?:need|have)\s+to)\b|\breste\s*:/i },
  { kind: "recommendation", re: /\b(recommandation|je\s+recommande|i\s+recommend|i'?d\s+recommend|recommendation)\b/i },
]
/** "nothing left to do", "rien à faire", "no follow-up" — a negation right
 *  before a marker makes it a clean sign-off, not a pending item. */
const NEGATION_BEFORE = /\b(nothing|no|none|rien|aucune?|n'?ai\s+rien|ne\s+reste\s+rien|no\s+further|no\s+more)\b[^.!?]{0,30}$/i

/** The last sentence announces an action rather than reporting a result
 *  ("Now drive it with the built CLI.") — the transcript stops mid-work.
 *  A sentence that also states an outcome ("Now it works.") does not count. */
const ANNOUNCES_NEXT = /^(?:now|next|then|ensuite|maintenant|puis|let\s+me(?!\s+know)|let'?s|i'?ll|i\s+will|je\s+vais|on\s+va)\b/i
const STATES_OUTCOME = /\b(is|are|was|were|works?|passes?|passed|green|done|merged|fixed|complete[d]?|ready|ok|terminé|fini|fonctionne)\b/i

function announcesNextAction(flat) {
  const sentences = flat.split(/(?<=[.!?])\s+/).filter(Boolean)
  const last = sentences.at(-1)?.trim()
  return !!last && last.length <= 160 && ANNOUNCES_NEXT.test(last) && !STATES_OUTCOME.test(last)
}

/**
 * Why a session's LAST assistant message still owes something, or `null`
 * when it reads as a clean final report. Reasons: `question to the user`,
 * `announced next action`, `open question`, `asks the user`, `waiting`, `next step`,
 * `recommendation`.
 * The tail the plan carries is ~600 chars, whitespace-flattened.
 */
export function pendingWorkReason(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null
  const flat = text.replace(/\s+/g, " ").trim()
  const recent = flat.slice(-QUESTION_WINDOW_CHARS)
  if (QUESTION_MARK.test(recent)) return "question to the user"
  if (announcesNextAction(flat)) return "announced next action"
  for (const { kind, re } of PENDING_PATTERNS) {
    const m = re.exec(flat)
    if (!m) continue
    if (NEGATION_BEFORE.test(flat.slice(Math.max(0, m.index - 40), m.index))) continue
    return kind
  }
  return null
}

/** Boolean form of {@link pendingWorkReason}. */
export const hasPendingWork = text => pendingWorkReason(text) !== null

/** PR states that mean "still waiting on someone" (not merged, not closed). */
const isOpenPrState = state => state === "open" || state === "OPEN"

/**
 * The remaining-work check for one session: reasons it must NOT be closed
 * or labelled `done`. Inputs are whatever the caller has — the last
 * assistant text and/or the worktree's PR state; missing inputs add no
 * reason. An empty list means nothing pending was found.
 */
export function remainingWork({ lastAssistantText, prState } = {}) {
  const reasons = []
  const pending = pendingWorkReason(lastAssistantText)
  if (pending) reasons.push(pending)
  if (isOpenPrState(prState)) reasons.push("open PR awaiting review/merge")
  return reasons
}

// ── self-exclusion (mission item 7) ──────────────────────────────────────

/** Two origins name the same cron job (`cron:<jobId>`). */
export function sameCronJob(origin, otherOrigin) {
  return isNonEmptyString(origin) && origin === otherOrigin && origin.startsWith("cron:")
}

/**
 * Whether a candidate is the steward's OWN cron lineage and must never be
 * judged as user work: the caller itself, or an older run of the same cron
 * job (`origin === callerOrigin`, both `cron:<jobId>`). A finished cron run
 * closes itself, or is a certain close — never a judge candidate.
 */
export function isSelfExcluded(session, opts = {}) {
  if (!session) return { excluded: true, reason: "no session" }
  if (opts.callerSessionId && session.id === opts.callerSessionId) return { excluded: true, reason: "caller session" }
  if (sameCronJob(session.origin, opts.callerOrigin)) return { excluded: true, reason: "same cron job as caller" }
  return { excluded: false, reason: null }
}

// ── re-check at apply time (mission item 6) ──────────────────────────────

/**
 * Re-read a candidate's live state right before acting. If it became busy,
 * or is no longer running/starting, SKIP — the snapshot it was planned from
 * is stale. `live` is a fresh `session_list` row (or `{status,busy}`).
 */
export function recheckApply(_entry, live) {
  if (!live) return { proceed: false, reason: "session disappeared before apply" }
  if (live.busy === true) return { proceed: false, reason: "became busy before apply" }
  if (live.status !== "running" && live.status !== "starting") {
    return { proceed: false, reason: `terminal before apply (${live.status})` }
  }
  return { proceed: true, reason: null }
}

// ── verdict memory (mission item 10) ─────────────────────────────────────

/** A short, stable fingerprint of the decision-relevant evidence — NOT the
 *  transcript text, which changes on every turn. Two passes with the same
 *  fingerprint reached the same verdict on unchanged evidence. */
export function evidenceFingerprint(evidence) {
  const pick = {
    status: evidence?.status ?? null,
    busy: evidence?.busy === true,
    awaitingInput: evidence?.awaitingInput === true,
    keepAlive: evidence?.keepAlive === true,
    turnsCompleted: evidence?.turnsCompleted ?? null,
    tokensIn: evidence?.tokensIn ?? null,
    tokensOut: evidence?.tokensOut ?? null,
    lastToolCall: evidence?.lastToolCall?.tool ?? null,
    toolTotal: evidence?.toolStats?.total ?? null,
    toolDistinct: evidence?.toolStats?.distinct ?? null,
    pr: evidence?.worktree?.pr?.state ?? null,
    lastTurnError: evidence?.lastTurnError ?? null,
    liveChildren: evidence?.liveChildren ?? null,
    continuedTo: evidence?.continuedTo ?? null,
    outcome: evidence?.outcome?.verdict ?? null,
  }
  return JSON.stringify(pick)
}

/**
 * Fold `app_state` `note` events of payload `kind:"steward-verdict"` into a
 * per-session memory: the last verdict, its fingerprint, and how many
 * consecutive passes agreed on the same (verdict, fingerprint). `streak`
 * resets the moment either changes.
 */
export function foldVerdictMemory(events) {
  const memory = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    const p = e?.payload
    if (e?.kind !== "note" || p?.kind !== "steward-verdict" || !isNonEmptyString(p.sessionId)) continue
    const prev = memory.get(p.sessionId)
    const streak = prev && prev.verdict === p.verdict && prev.fingerprint === p.fingerprint ? prev.streak + 1 : 1
    memory.set(p.sessionId, {
      verdict: p.verdict,
      confidence: typeof p.confidence === "number" ? p.confidence : null,
      fingerprint: p.fingerprint ?? null,
      streak,
      ts: e.ts ?? null,
      judgedBy: p.judgedBy ?? null,
    })
  }
  return memory
}

/**
 * Cache decision: a session already judged the SAME verdict on the SAME
 * evidence fingerprint for at least `stablePasses` consecutive passes is not
 * re-judged. Any evidence change (fingerprint differs) re-opens it.
 */
export function shouldRejudge(memory, sessionId, fingerprint, opts = {}) {
  const stablePasses = opts.stablePasses ?? 2
  const m = memory instanceof Map ? memory.get(sessionId) : memory?.[sessionId]
  if (!m) return { rejudge: true, cached: null }
  if (m.fingerprint !== fingerprint) return { rejudge: true, cached: null }
  if ((m.streak ?? 0) >= stablePasses) return { rejudge: false, cached: m }
  return { rejudge: true, cached: null }
}

/** The `app_state` event to append for one recorded verdict. */
export function verdictMemoryEvent(input = {}) {
  const payload = {
    kind: "steward-verdict",
    sessionId: input.sessionId,
    verdict: input.verdict,
    confidence: input.confidence ?? null,
    fingerprint: input.fingerprint ?? null,
    ...(input.judgedBy ? { judgedBy: input.judgedBy } : {}),
    ...(input.note ? { note: input.note } : {}),
  }
  return {
    kind: "note",
    by: "policy",
    stage: "session-steward",
    item: input.sessionId,
    payload,
  }
}

/**
 * An operator disagreement with a recorded verdict — logged as a Jev example
 * (mission item 10: "les désaccords opérateur sont journalisés comme
 * exemples"). Returns `null` when the operator agrees (or there is no prior).
 */
export function operatorDisagreement(memory, sessionId, operatorVerdict, opts = {}) {
  const m = memory instanceof Map ? memory.get(sessionId) : memory?.[sessionId]
  if (!m || !operatorVerdict || m.verdict === operatorVerdict) return null
  return {
    sessionId,
    judgeVerdict: m.verdict,
    judgeConfidence: m.confidence,
    operatorVerdict,
    fingerprint: m.fingerprint,
    ...(opts.at ? { at: opts.at } : {}),
  }
}

// ── host saturation (mission item 9) ─────────────────────────────────────

/** Load / core ratio above which the host counts as saturated. */
export const SATURATION_LOAD_PER_CORE = 4
/** Swap used above this percent counts as saturated. */
export const SATURATION_SWAP_PERCENT = 50
/** Available RAM below this percent of total counts as saturated. */
export const SATURATION_FREE_PERCENT = 15

/**
 * Is the host saturated, by the same thresholds `host_load`'s own warnings
 * use? Returns the reasons so the report can say why.
 */
export function hostSaturation(hostLoad) {
  if (!hostLoad) return { critical: false, reasons: [] }
  const reasons = []
  const perCore = typeof hostLoad.loadPerCore === "number" ? hostLoad.loadPerCore : null
  if (perCore !== null && perCore > SATURATION_LOAD_PER_CORE) {
    reasons.push(`load ${hostLoad.loadAvg?.[0]?.toFixed?.(1) ?? "?"} = ${perCore}x cores (> ${SATURATION_LOAD_PER_CORE}x)`)
  }
  const swapPct = hostLoad.swap?.percent
  if (typeof swapPct === "number" && swapPct > SATURATION_SWAP_PERCENT) reasons.push(`swap ${Math.round(swapPct)}% used`)
  const mem = hostLoad.memory
  if (mem && typeof mem.totalBytes === "number" && mem.totalBytes > 0) {
    const availPct = ((mem.availableBytes ?? mem.freeBytes ?? 0) / mem.totalBytes) * 100
    if (availPct < SATURATION_FREE_PERCENT) reasons.push(`RAM available ${availPct.toFixed(1)}% (< ${SATURATION_FREE_PERCENT}%)`)
  }
  return { critical: reasons.length > 0, reasons }
}

const fmtBytes = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?"
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Processes the log wants surfaced under saturation: reparented orphans,
 *  then big processes that are NOT owned by a session (acting on sessions
 *  alone fixes nothing). Report-only — no process is ever touched here. */
export function saturationHeader(hostLoad) {
  if (!hostLoad) return []
  const { critical, reasons } = hostSaturation(hostLoad)
  if (!critical) return []
  const lines = [`## ⚠ Host saturated — orphans & non-session processes first (report only)`, ""]
  lines.push(`- ${reasons.join(" · ")}`)
  const proc = (p) => `pid ${p.pid} ${p.command} (${fmtBytes(p.memoryBytes ?? p.rssBytes)}${p.elapsedSec ? `, ${Math.round(p.elapsedSec / 3600)}h` : ""})`
  const orphans = (hostLoad.processes ?? hostLoad.topByMemory ?? []).filter((p) => p?.owner?.kind === "orphan")
  const others = (hostLoad.processes ?? hostLoad.topByMemory ?? []).filter(
    (p) => p?.owner?.kind === "other" || p?.owner?.kind === "system" || p?.owner?.kind === "provisioning",
  )
  if (orphans.length > 0) lines.push(`- orphans: ${orphans.slice(0, 5).map(proc).join("; ")}`)
  if (others.length > 0) lines.push(`- big non-session: ${others.slice(0, 5).map(proc).join("; ")}`)
  const criticalWarnings = (hostLoad.warnings ?? []).filter((w) => w?.severity === "critical")
  if (criticalWarnings.length > 0) lines.push(`- warnings: ${criticalWarnings.map((w) => w.message).join("; ")}`)
  lines.push("")
  return lines
}

// ── explicit 0-candidate report (mission item 8) ─────────────────────────

/**
 * Why there is nothing to do, stated explicitly instead of an empty report:
 * how many live sessions were seen, how many were busy, how many were
 * terminal (and whether any still need a relabel), and how many were
 * excluded — with a per-reason breakdown (`counts.excludedByReason`) so the
 * report says exactly WHY (G6), e.g. `6 excluded (2 same_cron_job_as_caller,
 * 3 pty, 1 archived)`.
 */
export function explainZeroCandidates(counts = {}) {
  const n = (v) => (typeof v === "number" ? v : 0)
  const byReason = counts.excludedByReason
  let excluded = `${n(counts.excluded)} excluded`
  const breakdown = []
  if (byReason && typeof byReason === "object") {
    for (const [reason, count] of Object.entries(byReason)) {
      if (count > 0) breakdown.push(`${count} ${reason}`)
    }
  }
  if (breakdown.length > 0) excluded += ` (${breakdown.join(", ")})`
  return (
    `0 candidates: ${n(counts.live)} live (` +
    `${n(counts.busy)} busy, ${n(counts.idle)} idle), ` +
    `${n(counts.terminal)} terminal (${n(counts.terminalRelabel)} need a relabel), ` +
    excluded
  )
}

/** Nothing idle AND nothing terminal-without-outcome ⇒ a full workflow is
 *  not worth it; the caller can report and stop. */
export function shouldFastPath(scan = {}) {
  const busy = (scan.busy ?? []).length
  const idle = (scan.idle ?? []).length
  const terminalRelabel = (scan.terminalRelabel ?? []).length
  const neverRan = (scan.neverRan ?? []).length
  const anyIdleCandidate = idle > 0 || neverRan > 0 || terminalRelabel > 0
  return { fastPath: !anyIdleCandidate && busy > 0, anyIdleCandidate }
}

// ── proposals (mission items 1, 2) ───────────────────────────────────────

export const NUDGE_INTERRUPT = "interrupt"
export const NUDGE_CONTINUE = "continue"

/**
 * Merge loop and stall findings into at most ONE nudge proposal per session
 * per pass (interrupt wins over continue: a loop is more specific). A
 * user-origin session is NEVER proposed for a nudge — it is reported as
 * observed-only, so a human stays in the loop. Never proposes a close.
 */
export function buildProposals(input = {}) {
  const bySession = new Map()
  const consider = (id, kind, reason, originClass) => {
    if (!id) return
    const existing = bySession.get(id)
    if (existing) {
      if (existing.kind === NUDGE_INTERRUPT) return
      if (kind !== NUDGE_INTERRUPT) return
    }
    bySession.set(id, { sessionId: id, kind, reason, originClass })
  }
  for (const r of input.loopResults ?? []) {
    if (r?.looping) consider(r.sessionId, NUDGE_INTERRUPT, `loop: ${(r.reasons ?? []).join("; ")}`, r.originClass)
  }
  for (const r of input.stallResults ?? []) {
    if (r?.stalled) consider(r.sessionId, NUDGE_CONTINUE, `stall: ${r.reason}`, r.originClass)
  }
  const proposals = []
  const observed = []
  for (const p of bySession.values()) {
    if (p.originClass === "user") observed.push({ ...p, suppressed: "origine utilisateur" })
    else proposals.push(p)
  }
  return { proposals, observed }
}
