/**
 * Zod shapes for `agent_start` spawn fields that the HTTP twin
 * (`POST /sessions/agent`, `buildSpawnSessionHttpArgs`) must validate
 * identically — one definition, so the two surfaces can't drift (the same
 * reason `sandbox-spec-schema.ts` exists).
 */

import { z } from "zod"

/** `commandSandbox` — OS-level confinement mode for the adapter's own
 *  spawned process (`@agentproto/command-sandbox`'s `SandboxMode`). */
export const commandSandboxSchema = z.enum(["off", "workspace", "strict"])

/** `attach` — parent-attach control: `false` = independent root, `true` =
 *  force attach, `{ parent }` = pin an explicit parent. */
export const attachFieldSchema = z.union([
  z.boolean(),
  z.object({ parent: z.string().min(1).optional() }),
])

/** `contextContinuity` — per-session override of the context-continuity
 *  policy (warn / compact / continue-fresh / hard-stop thresholds + the
 *  carry-over sections). */
export const contextContinuityInputSchema = z.object({
  mode: z.enum(["manual", "ask", "auto"]).optional(),
  warnAtPct: z.number().int().min(0).max(100).optional(),
  compactAtPct: z.number().int().min(0).max(100).optional(),
  continueFreshAtPct: z.number().int().min(0).max(100).optional(),
  hardStopAtPct: z.number().int().min(0).max(100).optional(),
  goal: z.boolean().optional(),
  plan: z.boolean().optional(),
  decisions: z.boolean().optional(),
  changedFiles: z.boolean().optional(),
  gitStatus: z.boolean().optional(),
  tests: z.boolean().optional(),
  errors: z.boolean().optional(),
  risks: z.boolean().optional(),
  nextStep: z.boolean().optional(),
  config: z.boolean().optional(),
  label: z.string().optional(),
})
