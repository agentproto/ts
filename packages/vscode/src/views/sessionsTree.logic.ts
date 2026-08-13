/**
 * Pure sessions-tree mapping/grouping/sorting logic — NO vscode import.
 * sessionsTree.ts wraps these into vscode.TreeItem/ThemeIcon/MarkdownString
 * so the mapping rules stay unit-testable under plain vitest.
 */

import { isPendingSession } from "../services/pending.logic.js"
import { sessionDisplayName } from "../client/sessionName.js"
import type { SessionDescriptor } from "../client/types.js"

export type SessionContextValue =
  | "session-pending"
  | "session-live"
  | "session-awaiting"
  | "session-done"
  | "session-interrupted"

export interface SessionIcon {
  /** Codicon id (e.g. "play", "sync~spin") — no leading "$()". */
  id: string
  /** Semantic color hint for the icon, if any. */
  color?: "warning" | "error"
}

export interface TooltipField {
  label: string
  value: string
}

export interface SessionNode {
  session: SessionDescriptor
  children: SessionNode[]
}

export type TimeBucket = "recent" | "older"

/**
 * The rule drawn between the recent and the older session rows. Deliberately
 * NOT a group node: sessions stay at the top level, so there is nothing to
 * expand or collapse — this is one inert row that reads as a divider.
 */
export interface SeparatorNode {
  kind: "separator"
  /** Stable TreeItem id; the tree only ever holds one separator. */
  id: string
  /** Divider text, rendered dim — e.g. "──── older than 24h ────". */
  label: string
}

export type TreeNode = SeparatorNode | SessionNode

/**
 * Discriminates a divider row from a session row — shared with
 * sessionsGroups.logic.ts and sessionsTree.ts so both the grouping and the
 * tree-item mapping use the same check. Takes `unknown` (not TreeNode) so it
 * also narrows sessionsGroups.logic.ts's wider RootNode (TreeNode | GroupNode
 * | CtaNode) without a cast at every call site.
 */
export function isSeparatorNode(node: unknown): node is SeparatorNode {
  return (
    typeof node === "object" &&
    node !== null &&
    "kind" in node &&
    (node as { kind?: unknown }).kind === "separator"
  )
}

/** Description-string extras for the richer (post-filter) row rendering — see descriptionFor. */
export interface DescriptionContext {
  now?: number
  /** Direct children in the RENDERED tree — drives the "N subagents" suffix. */
  childCount?: number
}

/**
 * Leaf directory name of a session's worktree — what identifies a worktree to a
 * human (`sessions-tree-id-isolation`, a branch-shaped name), not the whole
 * path. Undefined when the session isn't inside a linked worktree. Mirrors the
 * CLI's `worktreeCell` (packages/cli sessions.ts), which shows the same
 * basename in its WORKTREE column. Handles both `/` and `\` separators and a
 * trailing slash so it's platform-agnostic without importing node:path (this
 * module stays vscode/node-free for the vitest suite).
 */
export function worktreeName(session: SessionDescriptor): string | undefined {
  const path = session.worktreePath
  if (!path) return undefined
  const trimmed = path.replace(/[/\\]+$/, "")
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  const leaf = cut >= 0 ? trimmed.slice(cut + 1) : trimmed
  return leaf || undefined
}

/** The git-fork glyph prefixing a worktree row — a plain unicode char, NOT a
 *  `$(codicon)`, because a TreeItem.description renders codicon markup
 *  literally. It's the visual tell that separates an isolated row from the
 *  bare-text "in-place". */
const WORKTREE_GLYPH = "⑂"

/**
 * A session's isolation posture as one compact row segment, REPLACING the
 * always-identical workspace name that used to sit here (redundant on every
 * row of the same monorepo). Two shapes:
 *   - in a worktree: `⑂ <leaf-name>` — which worktree, at a glance.
 *   - otherwise: `in-place` — spawned in the checkout itself.
 *
 * Absence of `worktreePath` is read as in-place: true for a plain checkout or
 * a non-repo dir (the common case), and — for the rare session persisted
 * before the runtime recorded the field — the honest best guess. The full
 * path + generation id live in the tooltip (`tooltipFieldsFor`).
 */
export function isolationLabelFor(session: SessionDescriptor): string {
  const name = worktreeName(session)
  return name ? `${WORKTREE_GLYPH} ${name}` : "in-place"
}

const TERMINAL_STATUSES = new Set<SessionDescriptor["status"]>(["exited", "killed", "error"])

export function isRunning(session: SessionDescriptor): boolean {
  return session.status === "running" || session.status === "starting"
}

export function isErrored(session: SessionDescriptor): boolean {
  return (
    session.status === "error" ||
    (typeof session.exitCode === "number" && session.exitCode > 0)
  )
}

export function isAwaiting(session: SessionDescriptor): boolean {
  return Boolean(session.awaitingInput || session.awaitingPermission)
}

/** Item label. Thin alias over the shared `sessionDisplayName` (SPEC-3 FIX D):
 *  `user-renamed-label > title > spawn-label > <adapter · short-id>`. A `label`
 *  a human wrote via `session_rename` (flagged `renamedByUser`) wins; otherwise
 *  the `title` derived from the session's first prompt outranks a spawn slug;
 *  the fallback names it by adapter + short id rather than the raw argv
 *  `command`, which reads as noise in a tree row. */
export function labelFor(session: SessionDescriptor): string {
  return sessionDisplayName(session)
}

/**
 * Max width for the live activity line when it leads a tree-row description.
 * The daemon caps the stored text at 160, still too wide for a narrow sidebar
 * row where the isolation/time metadata has to fit after it — the untruncated
 * text stays in the tooltip (`tooltipFieldsFor`).
 */
export const ACTIVITY_ROW_MAX = 72

/**
 * The session's live activity line as one row segment, or undefined when there
 * is none to show. Reads the persisted heuristic `activitySummary.text` the
 * daemon regenerates on turn-end ("what this session is doing now"), truncated
 * to keep the row readable. Blank/whitespace text is treated as absent so an
 * empty summary never leads a row with a bare ellipsis.
 */
export function activityLineFor(session: SessionDescriptor): string | undefined {
  const text = session.activitySummary?.text?.trim()
  if (!text) return undefined
  return text.length > ACTIVITY_ROW_MAX ? `${text.slice(0, ACTIVITY_ROW_MAX - 1)}…` : text
}

/**
 * Item description.
 *  - Without ctx (default): `adapterSlug ?? kind` + model (if any) + status —
 *    byte-identical to the pre-filter behavior existing call sites depend on.
 *  - With ctx: `isolation · relative time`, omitting the time when `ctx.now` is
 *    absent (never a literal "undefined"). The lead segment is the session's
 *    isolation posture (`isolationLabelFor` — `⑂ <worktree>` or `in-place`),
 *    which REPLACED the workspace name that used to sit here: on a tree whose
 *    rows are almost all the same monorepo, the workspace was identical on
 *    every row (and, in grouped mode, already named by the group header),
 *    whereas which worktree a session runs in genuinely varies and is what a
 *    technical operator reads to tell isolated work from in-place work.
 *
 * Deliberately NOT the token counts. `+68694 -141` on every row is a raw
 * number nobody acts on — it can't be compared across sessions (different
 * models, different work) and it isn't a budget. Cost and context-fill are the
 * numbers with a decision attached, and they already live in the transcript
 * header; a tree row is for identifying a session, not auditing it. The
 * per-session totals remain in the tooltip for anyone who does want them.
 */
export function descriptionFor(session: SessionDescriptor, ctx?: DescriptionContext): string {
  if (!ctx) {
    const parts = [session.adapterSlug ?? session.kind]
    if (session.model) parts.push(session.model)
    parts.push(session.status)
    return parts.join(" · ")
  }
  const parts: string[] = []
  // The live activity line LEADS the row when present — it's the "what is this
  // doing now" answer a list glance is for, so it outranks the isolation/time
  // metadata behind it (which the tooltip also carries). Absent (no turn-end
  // yet, or a human-renamed session the daemon never regenerates) → the row
  // reads exactly as before.
  const activity = activityLineFor(session)
  if (activity) parts.push(activity)
  parts.push(isolationLabelFor(session))
  if (session.origin) parts.push(`via ${session.origin}`)
  if (typeof ctx.now === "number") parts.push(relativeTime(session.startedAt, ctx.now))
  // A spawner says so on its own row. Indentation already nests the children,
  // but indentation is invisible the moment the row is collapsed or its
  // children scroll past — and "this session spawned 3 agents" is the whole
  // reason to look at it. Counted from the rendered subtree rather than the
  // descriptor, so it can never claim children the tree isn't showing.
  if (ctx.childCount && ctx.childCount > 0) {
    parts.push(`${ctx.childCount} subagent${ctx.childCount === 1 ? "" : "s"}`)
  }
  // Parked with background tasks still outstanding — say so on the row, or
  // the session reads as quietly idle while its work sits unfinished.
  const bg = session.pendingBgTasks ?? 0
  if (bg > 0) parts.push(`${bg} bg task${bg === 1 ? "" : "s"} pending`)
  return parts.join(" · ")
}

/**
 * How long a busy session may go silent before the tree stops calling it
 * healthy. Generous on purpose: `lastActivityAt` tracks ACP traffic, so a
 * single long tool call (a slow build, a big test run) legitimately goes quiet
 * for minutes and must not be branded stuck. What this catches is the other
 * shape — an agent that stopped emitting entirely and never sent `turn-end`,
 * leaving the daemon awaiting a turn that will never finish. That session sits
 * at `busy: true` forever, and a spinner claims it is working.
 */
export const STALL_AFTER_MS = 10 * 60_000

/**
 * How often the tree must repaint itself with no input from the daemon.
 *
 * Everything time-derived here — the relative timestamp in `descriptionFor`,
 * the recent/older split in `buildSessionRows`, and above all `isStalled` —
 * is a function of `now`, not of any event. The store only fires onDidChange
 * when a session actually CHANGED, so without a tick, a session that goes
 * quiet is exactly the session the tree never re-renders: stall detection,
 * whose entire trigger is silence, would surface only when some UNRELATED
 * session happened to emit an event. Self-defeating — and the reason the
 * view needed a manual refresh before it would tell the truth.
 *
 * 30s keeps the coarsest unit `formatDuration` prints honest and sits far
 * below STALL_AFTER_MS.
 */
export const TREE_REPAINT_INTERVAL_MS = 30_000

/** ms of silence for a busy session, or undefined when idle/terminal/unknown. */
export function silentForMs(session: SessionDescriptor, now: number): number | undefined {
  if (!session.busy || TERMINAL_STATUSES.has(session.status)) return undefined
  // lastActivityAt (any ACP traffic) is the truer liveness signal; lastOutputAt
  // (stdout/stderr) is the fallback for a descriptor predating it.
  const iso = session.lastActivityAt ?? session.lastOutputAt
  if (!iso) return undefined
  const last = Date.parse(iso)
  if (Number.isNaN(last)) return undefined
  return Math.max(0, now - last)
}

/** A busy session that has emitted nothing for STALL_AFTER_MS — busy in name only. */
export function isStalled(session: SessionDescriptor, now: number): boolean {
  const silent = silentForMs(session, now)
  return silent !== undefined && silent > STALL_AFTER_MS
}

/**
 * What a session IS, as one word — the single vocabulary the tree icons, the
 * status bar and the transcript chip all render.
 *
 * A session has two orthogonal axes and the UI kept rendering the wrong one.
 * `status` is LIFECYCLE ("is the process up?": starting/running/exited/…),
 * while what a person actually wants to know is ACTIVITY ("is it doing
 * anything, and does it need me?"). Reporting lifecycle where the reader
 * expects activity is what let the status bar say "9 running" about nine
 * agents that were parked doing nothing. This type is the activity axis;
 * `status` stays what it is, underneath.
 *
 * Ordered by urgency, because every consumer resolves the same way — the most
 * demanding true state wins:
 *   needs-you > stalled > parked-bg > working > idle > failed > stopped > done
 */
export type SessionActivity =
  | "needs-you" // awaiting input or a permission decision — blocked ON THE HUMAN
  | "stalled" // mid-turn but silent past STALL_AFTER_MS — busy in name only — OR idle after the adapter's own last turn reported failure (lastTurnErroredAt)
  | "parked-bg" // ended its turn with background tasks still pending — a silent dead end unless someone re-prompts
  | "working" // a turn is in flight (model generating, or a tool running)
  | "idle" // alive, no turn — parked, ready for a prompt
  | "failed" // ended badly: status "error", or a non-zero exit it wasn't asked for
  | "stopped" // killed while a turn was in flight, or before it ever finished one
  | "done" // ended cleanly on its own, OR killed only after its last turn finished

/**
 * `killed` alone doesn't say whether the session was cut off mid-work or
 * had already finished it — a supervisor reaping a child that reported back
 * looks identical to a human pressing Stop mid-turn: same `status: "killed"`,
 * same `exitCode: null`. Reading `busy` off a dead descriptor doesn't answer
 * it either — `runAgentTurn`'s `finally` is what clears `busy`, and it never
 * runs for a generator that's never resumed, so a killed-mid-tool-call
 * session can carry a stale `busy: true` forever. `turnsCompleted` alone is
 * too weak too: a session killed mid-SECOND-turn also has
 * `turnsCompleted: 1`.
 *
 * `killedMidTurn` is the daemon's answer to the one question that actually
 * matters — was a turn in flight the INSTANT it called `kill()` — captured
 * before anything could go stale (see SessionDescriptor.killedMidTurn).
 * Combined with `turnsCompleted`, that's enough to tell the three endings
 * apart: interrupted mid-turn is `stopped` regardless of how many turns
 * came before it; idle with nothing ever finished is also `stopped` (there
 * is no completed work to call `done`); only idle-after-finishing-something
 * reads as `done` — whether it was a supervisor reaping a child that
 * reported back or a human stopping an already-idle session, the work was
 * genuinely done either way.
 */
function killedActivityFor(session: SessionDescriptor): SessionActivity {
  const finishedBeforeKill =
    session.killedMidTurn !== true &&
    typeof session.turnsCompleted === "number" &&
    session.turnsCompleted > 0
  return finishedBeforeKill ? "done" : "stopped"
}

/**
 * Classify a session onto the activity axis.
 *
 * `now` is optional so existing call sites keep their behavior; without it a
 * stalled session is simply indistinguishable from a working one, as before.
 */
export function activityFor(session: SessionDescriptor, now?: number): SessionActivity {
  if (TERMINAL_STATUSES.has(session.status)) {
    // "killed" wins over the exit code, and must: SIGTERM is HOW stopping
    // works, so a stopped session carries exitCode 143 and `isErrored` calls
    // it a failure. Two sessions on a real daemon were painted red purely
    // because the user pressed Stop. Being stopped is not failing.
    if (session.status === "killed") return killedActivityFor(session)
    return isErrored(session) ? "failed" : "done"
  }
  if (isAwaiting(session)) return "needs-you"
  if (typeof now === "number" && isStalled(session, now)) return "stalled"
  // Coming up IS in motion. A starting session isn't busy yet — there's no turn
  // in flight, because there's no agent yet to run one — so it fell through to
  // `idle` and a booting adapter painted the same resting dot as a session
  // parked for an hour. It also outranks `stalled`'s silence check by sitting
  // below it: a session that hasn't started can't have gone quiet.
  if (session.status === "starting") return "working"
  // `blockedOn` splits this into working/waiting in the transcript header,
  // where there's room to say so. Here both mean the same thing to the reader
  // — in flight, leave it alone — and a 16px glyph is the wrong place to
  // spend a distinction nobody acts on.
  if (session.busy) return "working"
  // The adapter's OWN last turn reported failure in-band (see
  // SessionDescriptor.lastTurnErroredAt's docblock) — process is alive, no
  // turn in flight, but the last thing this session did needs a look, not a
  // re-prompt on faith. Folded into the same "stalled" treatment a mid-turn
  // stall gets rather than a new state. Checked AFTER busy so a session that
  // has already started retrying reads as working, not stalled — the marker
  // clears itself once that retry completes cleanly.
  if (session.lastTurnErroredAt) return "stalled"
  // Alive, no turn in flight, but background tasks from the last turn are
  // still outstanding — parked with work pending, a silent dead end unless
  // someone re-prompts. Checked AFTER busy so a session that IS still working
  // never reads as parked.
  if ((session.pendingBgTasks ?? 0) > 0) return "parked-bg"
  return "idle"
}

/** Coarse status buckets for the "group by status" view — the same taxonomy
 *  the status FILTER uses (sessionFilter.logic.ts), folded from the finer
 *  {@link SessionActivity}. `awaiting` first (most actionable), `done` last. */
export type StatusCategory = "awaiting" | "live" | "failed" | "stopped" | "done"

/** Display order for status groups — attention-first. */
export const STATUS_CATEGORY_ORDER: readonly StatusCategory[] = [
  "awaiting",
  "live",
  "failed",
  "stopped",
  "done",
]

const STATUS_CATEGORY_LABELS: Record<StatusCategory, string> = {
  awaiting: "Awaiting you",
  live: "Live",
  failed: "Failed",
  stopped: "Stopped",
  done: "Done",
}

export function statusCategoryLabel(category: StatusCategory): string {
  return STATUS_CATEGORY_LABELS[category]
}

/** Fold a session's fine-grained activity into its coarse status bucket. */
export function statusCategoryFor(session: SessionDescriptor, now?: number): StatusCategory {
  switch (activityFor(session, now)) {
    case "needs-you":
      return "awaiting"
    case "working":
    case "idle":
    case "stalled":
    case "parked-bg":
      return "live"
    case "failed":
      return "failed"
    case "stopped":
      return "stopped"
    case "done":
      return "done"
  }
}

/**
 * Icon per activity. The alphabet is deliberately small, and shaped so weight
 * carries meaning rather than decoration:
 *
 *   ● solid   = at rest        ○ spinning outline = in motion
 *   ✓ done    ⊘ stopped        ✗ failed
 *
 * Two of the old choices were actively misleading. `play` (▷) for an idle
 * session is an ACTION glyph used as a state — it reads "press me to run",
 * and it was the most common row on screen. `circle-slash` (⊘) for a clean
 * exit reads "forbidden": a session that did exactly its job got a
 * prohibition sign. ⊘ now means what it looks like — you stopped this.
 */
const ACTIVITY_ICONS: Record<SessionActivity, SessionIcon> = {
  "needs-you": { id: "question", color: "warning" },
  stalled: { id: "warning", color: "warning" },
  // Parked with background tasks still pending — a clock glyph in the warning
  // colour: time is passing and nobody will notice unless they look.
  "parked-bg": { id: "clock", color: "warning" },
  // The outline spinner, not `sync~spin`'s two chasing arrows: this is one
  // agent thinking, not two things being reconciled.
  working: { id: "loading~spin" },
  // The at-rest default. Weight is the read-receipt — see IDLE_UNREAD_ICON and
  // iconFor: hollow is "parked, nothing new".
  idle: { id: "circle-outline" },
  failed: { id: "error", color: "error" },
  stopped: { id: "circle-slash" },
  done: { id: "check" },
}

/**
 * A parked session sitting on output nobody has read yet.
 *
 * Weight is the only difference from the read dot, and that's the point: both
 * rows mean "parked", so they must read as the same KIND of thing — a filled
 * glyph is louder without being a different alphabet. The tree used to paint
 * every idle session filled, which made the loudest mark on screen the one
 * carrying no information at all.
 */
const IDLE_UNREAD_ICON: SessionIcon = { id: "circle-filled" }

/**
 * Icon for a session's current activity.
 *
 * `unread` only reaches the idle dot — every other state already answers a more
 * urgent question than "is there something new here?", and a working session's
 * spinner would be a lie about novelty besides. Omitted (undefined) means "no
 * read-receipt available", which paints filled: see isUnread on why unknown
 * must not read as read.
 */
/** Map an already-resolved activity to its icon (the tail of {@link iconFor},
 *  factored out so the subtree rollup can reuse it). */
export function iconForActivity(activity: SessionActivity, unread?: boolean): SessionIcon {
  if (activity === "idle") return unread === false ? ACTIVITY_ICONS.idle : IDLE_UNREAD_ICON
  return ACTIVITY_ICONS[activity]
}

export function iconFor(session: SessionDescriptor, now?: number, unread?: boolean): SessionIcon {
  return iconForActivity(activityFor(session, now), unread)
}

/**
 * Busiest-first rank over activities (#session-visibility, subtree rollup),
 * honoring the approved precedence busy > awaiting > … : a collapsed parent
 * inherits the most-active state in its subtree. `working` (a turn in flight,
 * anywhere below) outranks `needs-you`; terminal states rank lowest.
 */
const ACTIVITY_RANK: Readonly<Record<SessionActivity, number>> = {
  working: 7,
  "needs-you": 6,
  stalled: 5,
  "parked-bg": 4,
  idle: 3,
  failed: 2,
  stopped: 1,
  done: 0,
}

/** The busiest activity across a node and its whole subtree. Used to give a
 *  parent node the state of its most-active descendant, so a collapsed
 *  orchestrator doesn't read "idle" while its children are mid-turn. */
export function subtreeBusiestActivity(node: SessionNode, now?: number): SessionActivity {
  let busiest = activityFor(node.session, now)
  for (const child of node.children) {
    const childBusiest = subtreeBusiestActivity(child, now)
    if (ACTIVITY_RANK[childBusiest] > ACTIVITY_RANK[busiest]) busiest = childBusiest
  }
  return busiest
}

/**
 * A `killed` agent-cli row that died because the DAEMON went away out from
 * under it (`endedReason === "daemon-restart"`) — not an operator kill, a
 * natural exit, or an error. Such a row is a "resumable ghost": its descriptor
 * and the provider-side conversation both survive on disk, and a single plain
 * prompt to the SAME session id transparently revives it in place — the
 * daemon's lazy resume-on-prompt path (#634 billing-auth re-resolution, #635
 * interrupted-turn contract). Same id, same history.
 *
 * This is categorically different from `session_restart` (canRestart), which
 * mints a brand-NEW id — the two must never be conflated. PTY rows are excluded
 * unconditionally: a raw screen/shell can't be reconstructed in place, so those
 * revive only through `session_restart`'s pty-native `claude --resume` (new id).
 *
 * `interrupted` (SessionDescriptor.interrupted, #635) is ORTHOGONAL to this: a
 * daemon-restart ghost that was idle at death is still resumable in place here,
 * it just lost no work. `interrupted` only says whether the resume will surface
 * a "previous turn was dropped" banner.
 */
export function isResumableInPlace(session: SessionDescriptor): boolean {
  return (
    session.kind === "agent-cli" &&
    session.pty !== true &&
    session.status === "killed" &&
    session.endedReason === "daemon-restart"
  )
}

/** contextValue for menu gating: session-pending / session-live / session-awaiting / session-done / session-interrupted. */
export function contextValueFor(session: SessionDescriptor): SessionContextValue {
  // An optimistic row is not a session yet — it has no daemon-side id, so every
  // action on it (prompt, stop, restart) would 404. Its own contextValue means
  // the menus simply never offer them.
  if (isPendingSession(session)) return "session-pending"
  if (TERMINAL_STATUSES.has(session.status)) {
    // A daemon-restart ghost is terminal too, but it earns its OWN value so the
    // menus can offer resume-in-place (a plain prompt, same id) instead of only
    // new-id `session_restart`. Every other terminal row stays `session-done`.
    return isResumableInPlace(session) ? "session-interrupted" : "session-done"
  }
  if (isAwaiting(session)) return "session-awaiting"
  return "session-live"
}

/**
 * The tree-item `contextValue` a session actually renders with — `session-*`
 * suffixed `-archived` when the row is archived. Archived rows only ever
 * reach the tree when the "show archived" toggle is on (the daemon's
 * default `list()` already excludes them), so in practice this only ever
 * produces `session-done-archived` (archiving is guarded to terminal-status
 * sessions). Every EXISTING `view/item/context` `when` clause in
 * package.json is written `viewItem =~ /^session-(…)(-archived)?$/` so the
 * suffix doesn't hide open-transcript/open-terminal/restart from an
 * archived row — only `agentproto.archiveSession` (exact `session-done`)
 * and `agentproto.unarchiveSession` (exact `session-done-archived`) care
 * about the distinction.
 *
 * A watched session additionally gets `-watched` appended (after any
 * `-archived`), so the view/item/context menu can offer Watch only on rows
 * that aren't watched yet and Unwatch only on rows that are. The existing
 * `/^session-/` prefixes still match — the suffix only ever ADDS.
 */
export function treeContextValueFor(session: SessionDescriptor, watched?: boolean): string {
  return (
    contextValueFor(session) + (session.archived ? "-archived" : "") + (watched ? "-watched" : "")
  )
}

/** Appends an "archived" tag to a description string, e.g. "ws · 2h ago" →
 *  "ws · 2h ago · archived" — or bare "archived" when there was nothing
 *  else to show. */
export function withArchivedTag(description: string, archived: boolean | undefined): string {
  if (!archived) return description
  return description ? `${description} · archived` : "archived"
}

/** contextUsed/contextSize as a rounded percentage string, e.g. "42%". */
export function contextPercent(used?: number, size?: number): string | undefined {
  if (typeof used !== "number" || typeof size !== "number" || size <= 0) return undefined
  return `${Math.round((used / size) * 100)}%`
}

/** Ordered tooltip fields: id, cwd, isolation, pid, startedAt, activity, turnsCompleted, costUsd, tokensIn/Out, context %, blockedOn. */
export function tooltipFieldsFor(session: SessionDescriptor): TooltipField[] {
  const fields: TooltipField[] = [{ label: "id", value: session.id }]
  if (session.cwd) fields.push({ label: "cwd", value: session.cwd })
  // The row shows only the worktree's leaf name (or "in-place"); the tooltip
  // carries the full worktree path and its generation id — the pair that pins
  // one specific worktree, since a later worktree may reuse the same path.
  if (session.worktreePath) {
    fields.push({
      label: "worktree",
      value: session.worktreeId
        ? `${session.worktreePath} (${session.worktreeId})`
        : session.worktreePath,
    })
  } else {
    fields.push({ label: "isolation", value: "in-place" })
  }
  fields.push({ label: "pid", value: session.pid == null ? "—" : String(session.pid) })
  fields.push({ label: "startedAt", value: session.startedAt })
  // The full activity line (the row shows only a truncated lead segment) plus
  // its coarse state — the tooltip is where the untruncated "what it's doing"
  // sentence lives.
  if (session.activitySummary?.text?.trim()) {
    fields.push({
      label: "activity",
      value: session.activitySummary.state
        ? `${session.activitySummary.text} (${session.activitySummary.state})`
        : session.activitySummary.text,
    })
  }
  if (typeof session.turnsCompleted === "number") {
    fields.push({ label: "turns", value: String(session.turnsCompleted) })
  }
  // Parked with background tasks outstanding — the tooltip carries the count
  // the row's suffix summarizes.
  if ((session.pendingBgTasks ?? 0) > 0) {
    fields.push({ label: "bg tasks pending", value: String(session.pendingBgTasks) })
  }
  // The adapter's own last turn reported failure in-band — the marker behind
  // the "stalled" read the row now shows for an otherwise-idle session.
  if (session.lastTurnErroredAt) {
    fields.push({ label: "last turn errored", value: session.lastTurnErroredAt })
  }
  if (typeof session.costUsd === "number") {
    fields.push({ label: "cost", value: `$${session.costUsd.toFixed(4)}` })
  }
  if (typeof session.tokensIn === "number" || typeof session.tokensOut === "number") {
    fields.push({
      label: "tokens",
      value: `${session.tokensIn ?? 0} in / ${session.tokensOut ?? 0} out`,
    })
  }
  const pct = contextPercent(session.contextUsed, session.contextSize)
  if (pct) {
    fields.push({
      label: "context",
      value: `${pct} (${session.contextUsed}/${session.contextSize})`,
    })
  }
  // Only while a turn is actually in flight: a session killed mid-tool-call
  // keeps a stale blockedOn/busy forever (the daemon clears them in the turn's
  // finally, which never runs for a generator that is never resumed), and a
  // tooltip claiming a dead session is "blockedOn: command" is just wrong.
  if (session.blockedOn && isBlocked(session)) {
    fields.push({ label: "blockedOn", value: session.blockedOn })
  }
  return fields
}

/** True only when the session is taking a turn right now — the sole state in which blockedOn means anything. */
export function isBlocked(session: SessionDescriptor): boolean {
  return Boolean(session.blockedOn) && !TERMINAL_STATUSES.has(session.status) && Boolean(session.busy)
}

/** running-first, then most-recently-active desc (lastActivityAt → lastOutputAt → startedAt), with deterministic tie-breakers. */
export function compareSessions(a: SessionDescriptor, b: SessionDescriptor): number {
  const ra = isRunning(a)
  const rb = isRunning(b)
  if (ra !== rb) return ra ? -1 : 1
  const ta = recencyTimestamp(a)
  const tb = recencyTimestamp(b)
  if (ta !== tb) return tb - ta
  // Deterministic tie-breakers: startedAt desc, then id desc.
  const sa = Date.parse(a.startedAt)
  const sb = Date.parse(b.startedAt)
  if (!Number.isNaN(sa) && !Number.isNaN(sb) && sa !== sb) return sb - sa
  return b.id.localeCompare(a.id)
}

function recencyTimestamp(session: SessionDescriptor): number {
  const iso = session.lastActivityAt ?? session.lastOutputAt ?? session.startedAt
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * Collapse a resume chain to its tail: hide any session `S` for which some
 * OTHER session in the SAME input list has `resumedFrom === S.id`. A restart
 * mints a new session id and links back via `resumedFrom` (see the runtime's
 * `SessionDescriptor.resumedFrom` doc), so left unfiltered the tree shows
 * both the dead predecessor and its live successor as separate rows with
 * the same title. This hides the predecessor — transitively, so a chain
 * A→B→C (B resumed from A, C resumed from B) collapses to just C — without
 * dropping anything a survivor doesn't already cover: the predecessor's own
 * conversation is still reachable through the survivor's stitched transcript
 * (transcriptPanelController.ts's resume-chain stitch).
 *
 * Deliberately independent of `buildSessionTree`'s parentSessionId nesting —
 * `resumedFrom` is a REPLACEMENT relationship (same conversation, new
 * session id), not a spawner/subagent one, and a hidden predecessor must
 * never become a `SessionNode.children` entry: that array drives the
 * "N subagents" tree-row suffix (`descriptionFor`'s `ctx.childCount`), and a
 * resumed-from predecessor is not a subagent — it would misreport the count.
 *
 * A `resumedFrom` pointing at an id absent from `sessions` (successor
 * filtered out, e.g. archived, or the predecessor already missing from the
 * list) is ignored: nothing in `sessions` claims that id via `resumedFrom`
 * lookup unless the id is actually present as a session's own `id`, so the
 * predecessor stays visible whenever its successor isn't. Caller applies
 * this AFTER `filterSessions` — see sessionsTree.ts's `rebuild` — so a
 * predecessor is only hidden when its successor is actually shown.
 */
export function collapseResumeChains(sessions: readonly SessionDescriptor[]): SessionDescriptor[] {
  const resumedFromIds = new Set<string>()
  for (const session of sessions) {
    if (session.resumedFrom) resumedFromIds.add(session.resumedFrom)
  }
  return sessions.filter(session => !resumedFromIds.has(session.id))
}

/**
 * Group sessions into a parent/child tree: roots are sessions without a
 * (resolvable) parentSessionId; children are nested under their parent's
 * node (orchestrator subtrees). A parentSessionId pointing at an id absent
 * from the input list is treated as a root, so no session is ever dropped.
 * Every level (roots + each children array) is sorted per compareSessions.
 */
export function buildSessionTree(sessions: readonly SessionDescriptor[]): SessionNode[] {
  const byId = new Map<string, SessionNode>()
  for (const session of sessions) {
    if (!session?.id) continue
    byId.set(session.id, { session, children: [] })
  }

  const roots: SessionNode[] = []
  for (const node of byId.values()) {
    const parentId = node.session.parentSessionId
    const parent = parentId ? byId.get(parentId) : undefined
    if (parent && parent !== node) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortTree = (nodes: SessionNode[]): void => {
    nodes.sort((a, b) => compareSessions(a.session, b.session))
    for (const node of nodes) sortTree(node.children)
  }
  sortTree(roots)
  return roots
}

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Which side of the divider a session's `startedAt` falls on, relative to `now`. An unparsable startedAt is "older". */
export function bucketFor(session: SessionDescriptor, now: number): TimeBucket {
  const started = Date.parse(session.startedAt)
  if (Number.isNaN(started)) return "older"
  return now - started < MS_PER_DAY ? "recent" : "older"
}

/**
 * Human relative time for an ISO timestamp, e.g. "5 days ago", "2 hrs ago",
 * "just now". Clamps a negative delta (clock skew / future timestamp) to
 * "just now" rather than a nonsensical negative duration. An unparsable
 * `iso` renders as "—".
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "—"
  const diffMs = Math.max(0, now - then)
  if (diffMs < 45_000) return "just now"
  const minutes = Math.floor(diffMs / MS_PER_MINUTE)
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(diffMs / MS_PER_HOUR)
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(diffMs / MS_PER_DAY)
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? "" : "s"} ago`
}

export const SEPARATOR_ID = "separator-older"

/** Box-drawing rule around the divider's caption. Fixed width: a tree row can't measure the sidebar. */
const RULE = "─".repeat(8)

/**
 * Session roots as a FLAT top-level row list, with a single divider row
 * separating those started in the last 24h from the older ones.
 *
 * Recency is a top-level concern only: orchestrator subtrees
 * (parentSessionId nesting from buildSessionTree) stay intact under whichever
 * side their root lands on — a child never migrates across the divider on its
 * own `startedAt`.
 *
 * The divider is emitted ONLY when both sides are non-empty: a rule with
 * nothing above or below it separates nothing, and would just read as a
 * broken row.
 */
export function buildSessionRows(sessions: readonly SessionDescriptor[], now: number): TreeNode[] {
  const recent: SessionNode[] = []
  const older: SessionNode[] = []
  for (const root of buildSessionTree(sessions)) {
    if (bucketFor(root.session, now) === "recent") recent.push(root)
    else older.push(root)
  }

  if (recent.length === 0 || older.length === 0) return [...recent, ...older]
  const separator: SeparatorNode = {
    kind: "separator",
    id: SEPARATOR_ID,
    label: `${RULE} older than 24h ${RULE}`,
  }
  return [...recent, separator, ...older]
}

/** Compact duration for a silence window: "45s", "12min", "3h", "2d". */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
