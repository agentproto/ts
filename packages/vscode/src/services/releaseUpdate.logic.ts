/**
 * Pure update-prompt decision + update-plan logic — NO vscode import, so the
 * questions that matter (when to notify, what "Update now" means for THIS
 * build source, and the hard rule that execution only ever follows an
 * explicit Update-now) are unit-testable without the extension host (contract
 * WP-C from .plans/release-update-indicator-PLAN.md).
 *
 * Rules this module encodes:
 *  - A prompt fires only when a REAL newer release exists and the daemon is
 *    served from an installable source. `unknown`/`current`/no-`latest` never
 *    prompt.
 *  - Two snoozes, both persisted by the caller: `later` (silent until the
 *    next TTL) and `version` ("Not now" — silent for THIS version; a newer
 *    one may still prompt).
 *  - "Update now" NEVER executes here — it only builds a *plan* (the concrete
 *    commands) for the IO layer to run. Deciding anything other than update
 *    produces NO plan, so there is no code path where the module itself can
 *    trigger execution without an explicit `decision: "update"` (dedicated
 *    test below).
 *  - The plan differs by build.source: `tarball` → `npm i -g` + a clean
 *    daemon restart; `workspace` → open a terminal with pre-filled git/rebuild
 *    commands and a risk note (never run silently).
 */

import { compareVersions, type ReleaseBuildSource } from "@agentproto/runtime/release-check"

/** What a user can do with a prompt. `update` is the ONLY execution-opener. */
export type UpdateDecision = "update" | "later" | "not-now"

/** Persisted snooze, versioned like the other `~/.agentproto` stores. One of:
 *  - `later`   the "Later" button: silent until `untilMs` (next TTL).
 *  - `version` the "Not now" button: silent while the available release is
 *              `version`; a NEWER release may still prompt. */
export type ReleaseSnooze =
  | { kind: "later"; untilMs: number }
  | { kind: "version"; version: string }

/** The install channel, from the daemon's health.build.source. */
export type UpdateTarget = "tarball" | "workspace"

export interface UpdatePromptInput {
  /** Local CLI version (`health.version`). */
  localVersion: string | null
  /** Latest `@agentproto/cli`, when known (fresh npm or fresh cache). */
  latest: string | null
  /** Release check state, as decided by WP-A. */
  state: "current" | "behind" | "unknown" | "workspace"
  /** Daemon health.build.source. */
  buildSource: ReleaseBuildSource
  /** Current snooze, if any. */
  snooze: ReleaseSnooze | null
  /** Epoch ms "now". */
  nowMs: number
}

export type UpdatePromptDecision =
  | {
      kind: "prompt"
      target: UpdateTarget
      latest: string
      localVersion: string
    }
  | { kind: "silent"; reason: "no-update" | "unknown" | "snoozed-later" | "snoozed-version" }

/**
 * Decide whether to show an update prompt, and (when showing) what "Update
 * now" would mean for this build source. A prompt requires:
 *  - a usable latest AND local version;
 *  - that latest is actually ahead (an update exists);
 *  - the state is one that represents an available update
 *    (`behind` for a tarball, `workspace` for a workspace install — where a
 *    newer release means "rebuild required");
 *  - no active snooze (not silenced until next TTL, not "not now" for THIS
 *    version).
 */
export function decideUpdatePrompt(input: UpdatePromptInput): UpdatePromptDecision {
  const { localVersion, latest } = input
  if (!localVersion || !latest) return { kind: "silent", reason: "unknown" }
  if (compareVersions(latest, localVersion) <= 0) return { kind: "silent", reason: "no-update" }
  if (input.state === "current" || input.state === "unknown") {
    return { kind: "silent", reason: "no-update" }
  }
  if (input.snooze) {
    if (input.snooze.kind === "later" && input.nowMs < input.snooze.untilMs) {
      return { kind: "silent", reason: "snoozed-later" }
    }
    if (input.snooze.kind === "version" && input.snooze.version === latest) {
      return { kind: "silent", reason: "snoozed-version" }
    }
  }
  const target: UpdateTarget = input.buildSource === "workspace" ? "workspace" : "tarball"
  return { kind: "prompt", target, latest, localVersion }
}

/** `tarball` vs `workspace`, i.e. what a buildSource means for updating. */
export function updateTargetFor(buildSource: ReleaseBuildSource): UpdateTarget {
  return buildSource === "workspace" ? "workspace" : "tarball"
}

// ── Update plan ────────────────────────────────────────────────────────────

/**
 * A concrete update plan. This is the LAST thing a pure function produces —
 * the IO layer (`commands/releaseUpdate.ts`) is the only thing that runs it,
 * and only after the user explicitly chose Update now.
 */
export type UpdatePlan =
  | {
      kind: "tarball"
      /** `npm i -g @agentproto/cli@<latest>` — install the published release. */
      installCommand: string
      /** Cleanly restart the running daemon (`agentproto daemon restart`). */
      restartCommand: string
    }
  | {
      kind: "workspace"
      /** Pre-filled commands for a user-run terminal (git pull + rebuild +
       *  restart). NOT executed by us — the user presses Enter. */
      commands: string[]
      /** Why the user must review this: it touches the working tree and
       *  restarts the daemon for every client. */
      riskNote: string
      /** Short one-line description for the terminal title/banner. */
      label: string
    }

/**
 * The Update-now plan for a build source + version. Pure data: callers are
 * responsible for never executing a `tarball` plan without the explicit
 * decision gate (see decideUpdateFlow below).
 */
export function buildUpdatePlan(target: UpdateTarget, latest: string): UpdatePlan {
  if (target === "tarball") {
    return {
      kind: "tarball",
      installCommand: `npm i -g @agentproto/cli@${latest}`,
      restartCommand: "agentproto daemon restart",
    }
  }
  return {
    kind: "workspace",
    label: "agentproto: update (workspace rebuild)",
    commands: [
      "git -C projects/agentproto/ts pull",
      "pnpm --filter @agentproto/cli build",
      "agentproto daemon restart",
    ],
    riskNote:
      "This touches the local agentproto working tree and restarts the daemon " +
      "for every connected client. Review the commands; press Enter to run " +
      "them yourself.",
  }
}

/**
 * Full flow decision: given the user's choice, either produce a runnable plan
 * (Update now) or a snooze to record (Later / Not now) — or silence with no
 * effect. This is the gate that makes "no execution without
 * `decision: 'update'`" structural, not just convention.
 */
export interface UpdateFlow {
  /** The snooze to persist, if the user chose one. */
  snooze: ReleaseSnooze | null
  /** The plan to run, ONLY when the user chose Update now. */
  plan: UpdatePlan | null
}

export function decideUpdateFlow(
  decision: UpdateDecision,
  latest: string,
  nowMs: number,
  ttlMs: number,
  target: UpdateTarget,
): UpdateFlow {
  switch (decision) {
    case "update":
      return { snooze: null, plan: buildUpdatePlan(target, latest) }
    case "later":
      return { snooze: { kind: "later", untilMs: nowMs + ttlMs }, plan: null }
    case "not-now":
      return { snooze: { kind: "version", version: latest }, plan: null }
  }
}