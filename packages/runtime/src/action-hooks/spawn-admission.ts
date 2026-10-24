/**
 * Parity layer of the `builtin:spawn-admission` policy.
 *
 * Today this produces `allow`, `reuse` and `deny` for the spawn decisions
 * that `spawnAgentSession` already makes. `defer` (capacity) is added later
 * behind an opt-in. The claim map in `session-spawn.ts` stays the atomic
 * guard; this function only evaluates the facts the caller already has and
 * reads no registry, clock or claim map.
 */

import type { AdmissionDecision } from "./types.js"

export type SpawnDedupeSource = "explicit" | "implicit" | "worktree-cwd"

export type SpawnAdmissionCheck =
  | { stage: "claim"; source: "explicit" | "implicit";
      existing: undefined | { ok: true; sessionId: string } | { ok: false; code: string; message: string } }
  | { stage: "worktree-policy"; reject?: { message: string } }
  | { stage: "worktree-collision-sync"; collisionSessionId?: string }
  | { stage: "worktree-collision-async"; collisionSessionId?: string; label: string; cwd: string }

export interface SpawnAdmission { decision: AdmissionDecision; dedupeSource?: SpawnDedupeSource }

export function evaluateSpawnAdmission(check: SpawnAdmissionCheck): SpawnAdmission {
  switch (check.stage) {
    case "claim": {
      if (!check.existing) return { decision: { outcome: "allow" } }
      if (check.existing.ok) {
        return {
          decision: {
            outcome: "reuse",
            targetId: check.existing.sessionId,
            code: "spawn_claim_hit",
          },
          dedupeSource: check.source,
        }
      }
      return {
        decision: {
          outcome: "deny",
          code: check.existing.code,
          message: check.existing.message,
        },
      }
    }
    case "worktree-policy": {
      if (check.reject) {
        return {
          decision: {
            outcome: "deny",
            code: "worktree_disabled",
            message: check.reject.message,
          },
        }
      }
      return { decision: { outcome: "allow" } }
    }
    case "worktree-collision-sync": {
      if (check.collisionSessionId) {
        return {
          decision: {
            outcome: "reuse",
            targetId: check.collisionSessionId,
            code: "worktree_label_cwd_collision",
          },
          dedupeSource: "worktree-cwd",
        }
      }
      return { decision: { outcome: "allow" } }
    }
    case "worktree-collision-async": {
      if (check.collisionSessionId) {
        return {
          decision: {
            outcome: "deny",
            code: "worktree_label_cwd_collision",
            message:
              `agent_start: refused — another LIVE session ("${check.collisionSessionId}") already has the ` +
              `same label ("${check.label}") and cwd ("${check.cwd}") as this worktree spawn. ` +
              "Not starting a second agent in the same worktree.",
          },
        }
      }
      return { decision: { outcome: "allow" } }
    }
  }
}
