import { z } from "zod"
import { browserCapabilitiesSchema } from "./capabilities.js"
import type { BrowserAttachOptions, BrowserDriver } from "./driver.js"

// ---------- Manifest ----------

/** AIP-30 transport axis: how the host reaches the provider. */
export const browserTransportSchema = z.enum(["sdk", "http", "cli"])
export type BrowserTransport = z.infer<typeof browserTransportSchema>

/** `remote` means the browser runs on a third party's machine (a credential sink). */
export const browserLocationSchema = z.enum(["local", "remote"])
export type BrowserLocation = z.infer<typeof browserLocationSchema>

export const browserInstallSchema = z.object({
  method: z.enum(["path", "download", "curl", "vendored", "cloud"]),
  url: z.string().optional(),
  verify_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "must be a 64 char hex digest")
    .optional(),
  /** For `cloud`: env var name that holds the auth token. */
  secret: z.string().optional(),
})
export type BrowserInstall = z.infer<typeof browserInstallSchema>

export const browserRequiresSchema = z.object({
  /** Hard OS constraint (Node `process.platform` values). */
  os: z.array(z.string()).optional(),
  /** Allowed CPU architectures (Node `process.arch` values). */
  arch: z.array(z.string()).optional(),
  /** Platforms with a native launcher path; not a hard availability constraint. */
  nativeLaunchOs: z.array(z.string()).optional(),
})
export type BrowserRequires = z.infer<typeof browserRequiresSchema>

export const browserOptionSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["boolean", "integer", "string", "enum"]),
    description: z.string().optional(),
    enum: z.array(z.string()).optional(),
    default: z.union([z.boolean(), z.number(), z.string()]).optional(),
    /** Env vars to merge when the option is active. */
    env: z.record(z.string(), z.string()).optional(),
  })
  .refine((o) => o.type !== "enum" || (o.enum !== undefined && o.enum.length > 0), {
    message: "an option of type 'enum' must list its values in 'enum'",
  })
  .refine((o) => o.type === "enum" || o.enum === undefined, {
    message: "'enum' is only valid when type is 'enum'",
  })
  .refine(
    (o) => {
      if (o.default === undefined) return true
      if (o.type === "boolean") return typeof o.default === "boolean"
      if (o.type === "integer") return typeof o.default === "number" && Number.isInteger(o.default)
      if (o.type === "string") return typeof o.default === "string"
      // enum
      return typeof o.default === "string" && (o.enum?.includes(o.default) ?? false)
    },
    { message: "'default' must match 'type' (and be one of 'enum' when type is 'enum')" },
  )
export type BrowserOption = z.infer<typeof browserOptionSchema>

/** Post-install configuration prompt; matches the prompt arm of AIP-45 setup steps. */
export const browserConfigStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("prompt"),
  prompt: z.string(),
  description: z.string().optional(),
  type: z.enum(["text", "select", "boolean", "secret"]).optional(),
  default: z.string().optional(),
  options: z.array(z.string()).optional(),
  persist: z.object({ env: z.string() }).optional(),
})
export type BrowserConfigStep = z.infer<typeof browserConfigStepSchema>

/**
 * The declarative half of a provider. Everything but `launch`, so it can be
 * validated, serialized, listed and shipped without running any code.
 */
export const browserManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/, "must be lower-kebab, 2-80 chars"),
    name: z.string().min(1),
    description: z.string().min(1).max(2000),
    version: z.string().min(1),
    transport: browserTransportSchema,
    location: browserLocationSchema,
    capabilities: browserCapabilitiesSchema.default(() => browserCapabilitiesSchema.parse({})),
    install: z.array(browserInstallSchema).default([]),
    requires: browserRequiresSchema.default({}),
    options: z.array(browserOptionSchema).default([]),
    config: z.array(browserConfigStepSchema).default([]),
  })
  .strict()
export type BrowserManifest = z.infer<typeof browserManifestSchema>
export type BrowserManifestInput = z.input<typeof browserManifestSchema>

// ---------- Launch ----------

export const browserLaunchOptionsSchema = z.object({
  port: z.number().int().min(0).max(65535).optional(),
  /** Instance key part: a second launch with the same label reuses the running instance. */
  label: z.string().optional(),
  /** Named profile to start from, for providers with `persistentProfile`. */
  profile: z.string().optional(),
  headless: z.boolean().optional(),
  /** Base URL of an already-running or remote service. */
  baseUrl: z.string().optional(),
  /** Extra env vars for the spawned process. */
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
})
export type BrowserLaunchOptions = z.infer<typeof browserLaunchOptionsSchema>

/** What the host hands to a provider besides options. */
export interface BrowserHostContext {
  log?: (line: string) => void
  signal?: AbortSignal
}

// ---------- Instance ----------

export const browserStateSchema = z.enum([
  "launching",
  "running",
  "idle",
  "crash-looping",
])
export type BrowserState = z.infer<typeof browserStateSchema>

/**
 * The lifecycle fields a provider service may report on `/health` (Bureau's
 * camofox server does). All optional; a server reports `null` for a field
 * it has not set yet.
 */
export const browserLifecycleHealthSchema = z.object({
  bootId: z.string().nullish(),
  startedAt: z.string().nullish(),
  browserState: browserStateSchema.nullish(),
  launchedAt: z.string().nullish(),
  lastLaunchMs: z.number().nullish(),
  lastRestartReason: z.string().nullish(),
})
export type BrowserLifecycleHealth = z.infer<typeof browserLifecycleHealthSchema>

export const browserHealthSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  lifecycle: browserLifecycleHealthSchema.optional(),
})
export type BrowserHealth = z.infer<typeof browserHealthSchema>

export const browserEndpointsSchema = z.object({
  rest: z.string().optional(),
  cdp: z.string().optional(),
})
export type BrowserEndpoints = z.infer<typeof browserEndpointsSchema>

/** The serializable part of an instance (what a host can log or return over the wire). */
export const browserInstanceInfoSchema = z.object({
  id: z.string().min(1),
  endpoints: browserEndpointsSchema,
  pid: z.number().int().optional(),
  wasAlreadyRunning: z.boolean(),
})
export type BrowserInstanceInfo = z.infer<typeof browserInstanceInfoSchema>

/** One running browser, as returned by `launch`. */
export interface BrowserInstance extends BrowserInstanceInfo {
  health(): Promise<BrowserHealth>
  /** Bind a page-control driver to a target in this instance. */
  attach(opts?: BrowserAttachOptions): Promise<BrowserDriver>
  /**
   * Best-effort, idempotent stop. On an instance the host did not start
   * (`wasAlreadyRunning`), providers should not kill it.
   */
  stop(): Promise<void>
}

// ---------- Provider ----------

/** A defined provider: its frozen manifest plus `launch`. */
export interface BrowserProvider extends BrowserManifest {
  /**
   * Idempotent ensure: when a healthy instance already exists for the same
   * key, return it with `wasAlreadyRunning: true` and do not spawn another.
   */
  launch(
    opts: BrowserLaunchOptions,
    ctx: BrowserHostContext,
  ): Promise<BrowserInstance>
  /** Optional cheap "is this provider usable here" probe; never called by the lister. */
  check?(): Promise<boolean>
}

/** Input to `defineBrowser`: manifest fields plus `launch`. */
export interface BrowserDefinition extends BrowserManifestInput {
  launch: BrowserProvider["launch"]
  check?: BrowserProvider["check"]
}
