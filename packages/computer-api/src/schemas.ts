/**
 * Zod schemas for the computer controller's HTTP contract constants -
 * the generic, deployment-independent shape of every endpoint:
 *
 *   POST   /v1/computers            create
 *   GET    /v1/computers/:id        status
 *   POST   /v1/computers/:id/exec   synchronous exec of an argv array
 *   POST   /v1/computers/:id/suspend  full snapshot + stop
 *   POST   /v1/computers/:id/resume   restore into a FRESH computer
 *   POST   /v1/computers/:id/attach   take a session slot
 *   POST   /v1/computers/:id/detach   release a session slot
 *   DELETE /v1/computers/:id        rm + snapshot cleanup (?force=true skips the session check)
 *
 * These are deliberately MINIMAL: only the fields a client actually
 * consumes are declared, and every schema allows (and preserves) extra
 * fields so a controller version adding fields never breaks an older
 * client. Template ids are an OPEN string - any registered id is valid.
 *
 * Nothing deployment-specific belongs here: no host names, no IPs, no
 * tenant names, no auth realm details. Auth headers are wired by the
 * client, not the contract.
 */

import { z } from "zod"
import { computerStateSchema } from "./computer-states.js"

// ── transport pieces ──────────────────────────────────────────────────

/** A published port: the host-side port mapped to the guest-side port. */
export const portPublishSchema = z.object({
  host: z.number().int(),
  guest: z.number().int(),
})
export type PortPublish = z.infer<typeof portPublishSchema>

/** Egress allowlist entry in the create body: destination host + port. */
export const egressRuleSchema = z.object({
  host: z.string(),
  port: z.number().int(),
})
export type EgressRule = z.infer<typeof egressRuleSchema>

/**
 * Controller error bodies are always `{ error: string }`, sometimes with a
 * `detail` array of validation issues. The `code` strings a controller may
 * emit (for example unknown template, capacity) are contract-OPEN: clients
 * inspect but never switch exhaustively on them.
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  detail: z.unknown().optional(),
}).passthrough()
export type ErrorResponse = z.infer<typeof errorResponseSchema>

// ── POST /v1/computers ────────────────────────────────────────────────

/** Request body for `POST /v1/computers`. */
export const createComputerRequestSchema = z.object({
  /** Registered template id (OPEN string; a controller rejects unknown ids). */
  template: z.string(),
  /** Tenant the computer is created under (scope marker, not a name). */
  tenantId: z.string(),
  cpus: z.number().int().optional(),
  memoryMiB: z.number().int().optional(),
  rootDiskMiB: z.number().int().optional(),
  /** Computer TTL seconds. */
  ttl: z.number().int().optional(),
  /** Concurrent sessions the computer is sized for (controller default 1). */
  maxSessions: z.number().int().optional(),
  /** Environment variables injected into the computer. */
  env: z.record(z.string(), z.string()).optional(),
  /** Deny-by-default egress allowlist; a computer created without one has no DNS. */
  egress: z.object({ allow: z.array(egressRuleSchema) }).optional(),
}).passthrough()
export type CreateComputerRequest = z.infer<typeof createComputerRequestSchema>

/** 201 response body of `POST /v1/computers`. */
export const createComputerResponseSchema = z.object({
  id: z.string(),
  template: z.string(),
  state: z.string(),
  ports: z.array(portPublishSchema).optional(),
}).passthrough()
export type CreateComputerResponse = z.infer<typeof createComputerResponseSchema>

// ── GET /v1/computers/:id ─────────────────────────────────────────────

/**
 * Status response of `GET /v1/computers/:id` (status + published ports and
 * any egress/template metadata; extras preserved). The state is parsed
 * READ-tOLERANTLY: unknown future states bucket under `"unknown"`.
 */
export const computerStatusSchema = z.object({
  name: z.string(),
  state: computerStateSchema,
  ports: z.array(portPublishSchema).optional(),
  template: z.string().optional(),
  tenantId: z.string().optional(),
}).passthrough()
export type ComputerStatus = z.infer<typeof computerStatusSchema>

// ── POST /v1/computers/:id/exec ───────────────────────────────────────

/** Request body of `POST /v1/computers/:id/exec` - synchronous argv exec. */
export const execRequestSchema = z.object({
  argv: z.array(z.string()),
  /** Per-exec timeout; controllers cap this (for example at 600 seconds). */
  timeoutSec: z.number().int(),
}).passthrough()
export type ExecRequest = z.infer<typeof execRequestSchema>

/** 200 response body of `POST /v1/computers/:id/exec`. Controllers may
 *  redact registered secret values from the streams and cap their length. */
export const execResponseSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
}).passthrough()
export type ExecResponse = z.infer<typeof execResponseSchema>

// ── POST /v1/computers/:id/suspend ────────────────────────────────────

/** 200 response body of `POST /v1/computers/:id/suspend`. */
export const suspendResponseSchema = z.object({
  ok: z.boolean().optional(),
  snapshot: z.string().optional(),
  state: z.string().optional(),
}).passthrough()
export type SuspendResponse = z.infer<typeof suspendResponseSchema>

// ── POST /v1/computers/:id/resume ─────────────────────────────────────

/**
 * Response of `POST /v1/computers/:id/resume`. MAY rename the computer:
 * the controller can restore the suspend snapshot into a FRESH computer
 * under a NEW generated id and answer `{ id: <new>, state: "running" }`.
 * Callers must treat the old id as gone and adopt the returned id.
 */
export const resumeResponseSchema = z.object({
  ok: z.boolean().optional(),
  id: z.string().optional(),
  state: z.string().optional(),
}).passthrough()
export type ResumeResponse = z.infer<typeof resumeResponseSchema>

// ── POST /v1/computers/:id/attach | detach ────────────────────────────

/**
 * 200 response body of `POST /v1/computers/:id/attach` and `.../detach`:
 * the controller-held session count after the call and the cap the computer
 * was sized for. Neither route takes a body. Attach answers 409 when the
 * computer already hosts `maxSessions` sessions; detach floors at 0.
 * `DELETE /v1/computers/:id` answers 409 while sessions are attached unless
 * the `force=true` query parameter is passed.
 */
export const sessionsResponseSchema = z.object({
  sessions: z.number().int().optional(),
  maxSessions: z.number().int().optional(),
}).passthrough()
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>
