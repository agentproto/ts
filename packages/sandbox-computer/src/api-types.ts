/**
 * Zod schemas mirroring the computer controller's HTTP contract —
 * `GET/POST /v1/computers[...]` with `Authorization: Bearer <service token>`
 * plus `X-Tenant-Id`. These are deliberately MINIMAL: only the fields this
 * adapter actually consumes are declared, and every schema allows extra
 * fields so a controller version adding fields never breaks an older client.
 *
 * The controller is the source of truth for these shapes; this module is a
 * mirror for type-safety on the client side (see the controller's
 * `src/api/app.ts` / `src/driver/types.ts`).
 */

import { z } from "zod"

/**
 * Driver-level computer states, as reported by `GET /v1/computers/:id`
 * (`SandboxStatus` in the controller's driver contract). The controller
 * never itself reports `suspended` — a suspended computer reads back as
 * `stopped` with a suspend snapshot on it — but the state is kept here as a
 * tolerated alias so a newer controller can report it without breaking.
 */
export const COMPUTER_STATES = [
  "running",
  "stopped",
  "paused",
  "crashed",
  "starting",
  "unknown",
  "missing",
  "suspended",
] as const

export type ComputerState = (typeof COMPUTER_STATES)[number]

const stateSchema = z.string().transform((v): ComputerState => {
  // Tolerate unknown future states by bucketing them under "unknown" instead
  // of rejecting: a status read must never throw on controller evolution.
  return (COMPUTER_STATES as readonly string[]).includes(v) ? (v as ComputerState) : "unknown"
})

const portPublishSchema = z.object({
  host: z.number().int(),
  guest: z.number().int(),
})

/** `GET /v1/computers/:id` response (status + egress metadata, extras ignored). */
export const computerStatusSchema = z.object({
  name: z.string(),
  state: stateSchema,
  ports: z.array(portPublishSchema).optional(),
  template: z.string().optional(),
  tenantId: z.string().optional(),
}).passthrough()

export type ComputerStatus = z.infer<typeof computerStatusSchema>

/** `POST /v1/computers` — 201 response body. */
export const createComputerResponseSchema = z.object({
  id: z.string(),
  template: z.string(),
  state: z.string(),
}).passthrough()

export type CreateComputerResponse = z.infer<typeof createComputerResponseSchema>

/** `POST /v1/computers/:id/exec` — 200 response body (controller redacts
 *  registered secret values from the streams and caps their length). */
export const execResponseSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
}).passthrough()

export type ExecResponse = z.infer<typeof execResponseSchema>

/** `POST /v1/computers/:id/suspend` — 200 response body. */
export const suspendResponseSchema = z.object({
  ok: z.boolean().optional(),
  snapshot: z.string().optional(),
  state: z.string().optional(),
}).passthrough()

export type SuspendResponse = z.infer<typeof suspendResponseSchema>

/**
 * `POST /v1/computers/:id/resume` — MAY rename the computer: the controller
 * restores the suspend snapshot into a FRESH computer under a NEW generated
 * name and answers `{ id: <new>, state: "running" }`. Callers must treat
 * the old id as gone and adopt the returned id.
 */
export const resumeResponseSchema = z.object({
  ok: z.boolean().optional(),
  id: z.string().optional(),
  state: z.string().optional(),
}).passthrough()

export type ResumeResponse = z.infer<typeof resumeResponseSchema>

/** Controller error bodies are always `{ error: string }` (sometimes with a
 *  `detail` array of validation issues). */
export const errorResponseSchema = z.object({
  error: z.string(),
  detail: z.unknown().optional(),
}).passthrough()
