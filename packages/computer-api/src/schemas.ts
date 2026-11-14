/**
 * Zod schemas for the computer controller's HTTP contract constants -
 * the generic, deployment-independent shape of every endpoint:
 *
 *   POST   /v1/computers            create
 *   GET    /v1/computers            list every computer (the gc surface)
 *   GET    /v1/computers/:id        status
 *   POST   /v1/computers/:id/exec   synchronous exec of an argv array
 *   POST   /v1/computers/:id/suspend  full snapshot + stop
 *   POST   /v1/computers/:id/resume   restore into a FRESH computer
 *   POST   /v1/computers/:id/attach   take a session slot
 *   POST   /v1/computers/:id/detach   release a session slot
 *   DELETE /v1/computers/:id        rm + snapshot cleanup (?force=true skips the session check)
 *   GET    /v1/capacity             host capacity budget/committed/available
 *   GET    /v1/egress-pool          egress address pool slots
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
 * Egress IP selection in the create body: `"shared"` (default), `"auto"`,
 * `"dedicated"`, or a 1-8 character lowercase alphanumeric pool slot id.
 */
export const egressIpSelectionSchema = z
  .string()
  .regex(/^(shared|auto|dedicated|[a-z0-9]{1,8})$/)
export type EgressIpSelection = z.infer<typeof egressIpSelectionSchema>

/** The public egress address a controller brokered for a computer. */
export const egressIpSchema = z.object({
  id: z.string(),
  publicIp: z.string(),
}).passthrough()
export type EgressIp = z.infer<typeof egressIpSchema>

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
  /** Egress IP selection; omitted means the controller default (`"shared"`). */
  egressIp: egressIpSelectionSchema.optional(),
}).passthrough()
export type CreateComputerRequest = z.infer<typeof createComputerRequestSchema>

/** 201 response body of `POST /v1/computers`. */
export const createComputerResponseSchema = z.object({
  id: z.string(),
  template: z.string(),
  state: z.string(),
  ports: z.array(portPublishSchema).optional(),
  egressIp: egressIpSchema.nullable().optional(),
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
  egressIp: egressIpSchema.nullable().optional(),
}).passthrough()
export type ComputerStatus = z.infer<typeof computerStatusSchema>

// ── GET /v1/computers ─────────────────────────────────────────────────

/**
 * One computer as listed by `GET /v1/computers`: its name (the id used by
 * every other `/v1/computers/:id` route), its state, and the session slots
 * the controller counts for it. `sessions` is read TOLERANTLY - a controller
 * may report a count or a list of session holders, so both shapes parse.
 *
 * The W0b ownership/activity fields (`hostId`, `hostUrl`, `tenantId`,
 * `endUser`, `state`, `lastActivityAt`, `cpus`) are all optional: a
 * controller that predates W0b simply omits them, and a field that is
 * absent stays absent downstream rather than being invented.
 */
export const computerListEntrySchema = z.object({
  name: z.string(),
  state: computerStateSchema.optional(),
  sessions: z.union([z.number().int(), z.array(z.unknown())]).optional(),
  /** Memory the box holds, when the controller reports it. */
  memoryMiB: z.number().int().optional(),
  /** Creation timestamp (ISO-8601), when the controller reports it. */
  createdAt: z.string().optional(),
  /** Virtual CPUs allocated to the box (W0b), when reported. */
  cpus: z.number().int().optional(),
  /** Host identifier owning the box (W0b), when reported. */
  hostId: z.string().optional(),
  /** Public URL clients use for the host (W0b), when reported. */
  hostUrl: z.string().optional(),
  /** Owning tenant (W0b), when reported. */
  tenantId: z.string().optional(),
  /** End user inside the tenant (W0b), when reported. */
  endUser: z.string().optional(),
  /** Last activity timestamp (W0b, ISO-8601), when reported. */
  lastActivityAt: z.string().optional(),
  /** Public egress address, when the controller reports it on the list. */
  egressIp: egressIpSchema.nullable().optional(),
}).passthrough()
export type ComputerListEntry = z.infer<typeof computerListEntrySchema>

/**
 * Response of `GET /v1/computers` - every computer the controller knows
 * about for the calling tenant. This is the surface the gc pass reads to
 * find ORPHAN boxes: computers the controller still holds (with their RAM
 * and their session slots) that no live agentproto session references.
 */
export const computerListResponseSchema = z.object({
  computers: z.array(computerListEntrySchema),
}).passthrough()
export type ComputerListResponse = z.infer<typeof computerListResponseSchema>

// ── GET /v1/usage ─────────────────────────────────────────────────────

/**
 * One usage window, the exact W0 `UsageWindow` shape
 * (`projects/computer/CONTRACT-SCALE.md`). Camel-case JSON, ISO-8601 UTC
 * times, whole seconds, EUR. Optional fields stay absent when the ledger
 * does not know them. `costEur` is `null` when the host has no price model,
 * never `0`.
 */
export const usageWindowSchema = z.object({
  computer: z.string(),
  tenantId: z.string(),
  endUser: z.string().optional(),
  provider: z.enum(["computer", "e2b"]),
  host: z.string().optional(),
  from: z.string(),
  to: z.string(),
  activeSec: z.number(),
  vcpuSec: z.number(),
  gibSec: z.number(),
  costEur: z.number().nullable(),
  eventId: z.string().optional(),
}).passthrough()
export type UsageWindow = z.infer<typeof usageWindowSchema>

/** Totals over the returned usage windows. `costEur` and `storageEur` are
 *  `null` when the host has no price model, never `0`. */
export const usageTotalsSchema = z.object({
  activeSec: z.number(),
  vcpuSec: z.number(),
  gibSec: z.number(),
  costEur: z.number().nullable(),
  snapshotBytes: z.number().optional(),
  storageEur: z.number().nullable().optional(),
}).passthrough()
export type UsageTotals = z.infer<typeof usageTotalsSchema>

/**
 * Response of `GET /v1/usage?from=<iso>&to=<iso>[&endUser=..]`. `host` is
 * the host-level view: `unallocatedEur` is admin-only and `null` for a
 * tenant token.
 */
export const usageResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  windows: z.array(usageWindowSchema),
  totals: usageTotalsSchema,
  host: z.object({ unallocatedEur: z.number().nullable() }).passthrough().optional(),
}).passthrough()
export type UsageResponse = z.infer<typeof usageResponseSchema>

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
 * Optional request body of `POST /v1/computers/:id/attach` and `.../detach`:
 * a stable holder identity (the agentproto session id of the daemon taking
 * or releasing the slot). A controller that knows the holder can make
 * re-attach idempotent (a restarted daemon re-attaches onto the slot its
 * dead predecessor still held instead of hitting the 409 session limit) and
 * scope the detach to that holder's slot. Absent on both routes: a body-less
 * attach/detach keeps the legacy anonymous counting. `detach` ignores the
 * holder of an unknown slot (no-op for that holder).
 */
export const attachRequestSchema = z.object({
  holder: z.string().min(1).max(128).optional(),
}).passthrough()
export type AttachRequest = z.infer<typeof attachRequestSchema>

/**
 * 200 response body of `POST /v1/computers/:id/attach` and `.../detach`:
 * the controller-held session count after the call and the cap the computer
 * was sized for. Attach answers 409 when the computer already hosts
 * `maxSessions` sessions (an attach by a holder that already holds a slot
 * is idempotent: 200 with the count unchanged); detach floors at 0.
 * `DELETE /v1/computers/:id` answers 409 while sessions are attached unless
 * the `force=true` query parameter is passed.
 */
export const sessionsResponseSchema = z.object({
  sessions: z.number().int().optional(),
  maxSessions: z.number().int().optional(),
}).passthrough()
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>

// ── controller errors ─────────────────────────────────────────────────

/**
 * Egress-selection errors: `400 egress-pool-disabled`, `400
 * egress-pool-unknown`, `409 egress-pool-exhausted`, `409
 * egress-slot-dedicated`.
 */
export const egressErrorResponseSchema = z.object({
  error: z.enum([
    "egress-pool-disabled",
    "egress-pool-unknown",
    "egress-pool-exhausted",
    "egress-slot-dedicated",
  ]),
}).passthrough()
export type EgressErrorResponse = z.infer<typeof egressErrorResponseSchema>

/** `503 host-capacity` body. The controller also sends a `Retry-After`
 *  response header, which is not part of the JSON body. */
export const hostCapacityErrorResponseSchema = z.object({
  error: z.literal("host-capacity"),
  resource: z.string(),
  requested: z.number(),
  available: z.number(),
}).passthrough()
export type HostCapacityErrorResponse = z.infer<typeof hostCapacityErrorResponseSchema>

// ── GET /v1/capacity ──────────────────────────────────────────────────

/** One host resource's capacity: total budget, amount committed, amount free. */
export const resourceCapacitySchema = z.object({
  budget: z.number(),
  committed: z.number(),
  available: z.number(),
}).passthrough()
export type ResourceCapacity = z.infer<typeof resourceCapacitySchema>

/** Response of `GET /v1/capacity` — host capacity plus the computer count. */
export const capacityResponseSchema = z.object({
  memoryMiB: resourceCapacitySchema,
  cpus: resourceCapacitySchema,
  computers: z.number().int(),
}).passthrough()
export type CapacityResponse = z.infer<typeof capacityResponseSchema>

// ── GET /v1/egress-pool ───────────────────────────────────────────────

/** One egress pool entry: slot id, source address, public address, usage. */
export const egressPoolEntrySchema = z.object({
  id: z.string(),
  sourceIp: z.string(),
  publicIp: z.string(),
  computers: z.number().int(),
}).passthrough()
export type EgressPoolEntry = z.infer<typeof egressPoolEntrySchema>

/** Response of `GET /v1/egress-pool`. */
export const egressPoolResponseSchema = z.array(egressPoolEntrySchema)
export type EgressPoolResponse = z.infer<typeof egressPoolResponseSchema>
