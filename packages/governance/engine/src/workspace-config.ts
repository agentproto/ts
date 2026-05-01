/**
 * GovernanceConfig — runtime configuration the FS-only services need.
 *
 * Apps resolve genesis seed + HMAC secret from a vault / secrets manager and
 * pass an instance into the runtime services. The package itself does NOT
 * read environment variables or secret stores — it stays portable.
 */

import { z } from "zod"
import type { IGovernanceFilesystem } from "./filesystem.js"

export interface GovernanceConfig {
  /** Absolute path to the workspace root. */
  workspaceRoot: string

  /** Hex-encoded 64-char workspace genesis seed. */
  genesisSeed: string

  /** HMAC secret used for chain signatures. */
  hmacSecret: string

  /**
   * Filesystem adapter. Defaults to `NodeGovernanceFilesystem` (node:fs)
   * when omitted. Apps with non-POSIX storage (Supabase Storage, S3,
   * in-memory test fixtures) supply a custom implementation here.
   */
  filesystem?: IGovernanceFilesystem

  /** Optional: invoked when an audit-log line crosses an anchor threshold. */
  anchorSink?: AnchorSink

  /** Anchor every N lines (default 1000). */
  anchorEveryLines?: number
}

export interface AnchorPayload {
  /** Audit-log file path (workspace-relative). */
  logPath: string
  /** 0-based line index that triggered the anchor (the line that crossed the threshold). */
  lineIndex: number
  /** The signature at that line — what gets anchored. */
  signature: string
  /** ISO timestamp when the anchor was emitted. */
  emittedAt: string
}

export type AnchorSink = (payload: AnchorPayload) => Promise<void>

/** Default anchor cadence. */
export const DEFAULT_ANCHOR_EVERY_LINES = 1000

/**
 * Zod schema for GovernanceConfig — used by AIP-14 tool `contextSchema`
 * fields so the host-injected config is validated at the tool boundary.
 *
 * Function/interface fields (`filesystem`, `anchorSink`) are typed via
 * `z.custom` since zod can't deep-validate them; their presence is
 * checked by the runtime helpers downstream.
 */
export const governanceConfigSchema: z.ZodType<GovernanceConfig> = z.object({
  workspaceRoot: z.string().min(1),
  genesisSeed: z.string().regex(/^[a-f0-9]{64}$/),
  hmacSecret: z.string().min(1),
  filesystem: z.custom<IGovernanceFilesystem>().optional(),
  anchorSink: z.custom<AnchorSink>().optional(),
  anchorEveryLines: z.number().int().positive().optional(),
})

/**
 * Standard `contextSchema` shape for governance tools — the host MUST
 * inject `governanceConfig` at invocation time.
 */
export const governanceToolContextSchema = z.object({
  governanceConfig: governanceConfigSchema,
})

export type GovernanceToolContext = z.infer<typeof governanceToolContextSchema>
