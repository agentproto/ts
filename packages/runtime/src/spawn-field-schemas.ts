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

/** A single ACP-shaped content block, e.g. `{type:"text", text:"..."}` or
 *  `{type:"image", data, mimeType}` — validated loosely (any non-empty
 *  object) so the daemon doesn't duplicate the adapter's own block-shape
 *  rules; an ill-formed block surfaces as a clear turn error from the
 *  adapter instead (see `POST /sessions/:id/prompt`'s doc). */
const contentBlockSchema = z.record(z.string(), z.unknown())

/** `prompt` on `agent_prompt` and `agent_start` — a plain string (the
 *  common case) or a content block / block array for a multimodal turn
 *  (e.g. a pasted image), same loose shape `POST /sessions/:id/prompt`
 *  already accepts over HTTP. Forwarded to the registry verbatim; the
 *  adapter negotiates its own content support. */
export const promptInputSchema = z.union([
  z.string().min(1),
  contentBlockSchema,
  z.array(contentBlockSchema).min(1),
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
  handoffAtQuotaRemaining: z.number().min(0).optional(),
  compactRequiresOperator: z.boolean().optional(),
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
