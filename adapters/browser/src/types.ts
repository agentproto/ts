// ─── Core handle ──────────────────────────────────────────────────────────────

export interface BrowserAdapterHandle {
  /** Stable identifier — "camofox" | "bureau" | "chromium" | "chrome-live" */
  id: string
  name: string
  description: string
  defaultPort: number
  /** Path used for health probing, e.g. "/health" */
  healthPath: string

  // ── Declarative manifest fields (T8) — read-only metadata, no behaviour ────

  /**
   * Where this adapter runs.  Defaults to "local" when absent.
   * MVP: each adapter declares exactly one location.
   */
  location?: "local" | "cloud"

  /**
   * How to obtain / install the underlying binary or service.
   * Informational for now; T9 will wire these into `ensure`.
   */
  install?: BrowserAdapterInstall[]

  /**
   * Post-install configuration prompts.  Structurally compatible with the
   * prompt-arm of AIP-45 `AgentCliSetupStep` (type-import not taken to keep
   * this package dep-free of `@agentproto/driver-agent-cli`).
   *
   * Note: `persist.env` here is a SUBSET of the `env` arm of the AIP-45 union
   * (`{ env: string }`).  The union also supports `secret_slug` and `cmd` arms
   * which are not represented here.  Extend toward the full union if those
   * variants become necessary rather than adding a single-line Extract<>.
   */
  config?: BrowserAdapterConfigStep[]

  /**
   * Platform constraints.  Mirrors `AgentCliRequires` from AIP-45 but
   * redeclared here to avoid the dep (same rationale as `config`).
   */
  requires?: BrowserAdapterRequires

  /**
   * Typed runtime knobs.  Mirrors `AgentCliOption` (minimal subset).
   * Not wired into `ensure` until T9.
   */
  options?: BrowserAdapterOption[]

  // ── Runtime ───────────────────────────────────────────────────────────────

  /**
   * Ensure the service is up and return a live instance descriptor.
   * Idempotent: if already healthy, returns immediately with wasAlreadyRunning: true.
   */
  ensure(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance>
}

// ─── Install ──────────────────────────────────────────────────────────────────

/**
 * One entry in `BrowserAdapterHandle.install`.
 *
 * - "path"      — binary already on the system at a known path (or on PATH).
 * - "download"  — fetch a release archive and extract a binary.
 * - "curl"      — pipe through a shell installer script.
 * - "vendored"  — shipped inside this monorepo / npm package.
 * - "cloud"     — adapter is a remote URL, not a local process.
 */
export interface BrowserAdapterInstall {
  method: "path" | "download" | "curl" | "vendored" | "cloud"
  /** For "download" / "curl" / "cloud" — the source URL. */
  url?: string
  /** Optional SHA-256 hex digest to verify a downloaded artifact. */
  verify_sha256?: string
  /** For "cloud" — env-var name that holds the auth token (e.g. "BROWSER_SERVICE_KEY"). */
  secret?: string
}

// ─── Config steps ─────────────────────────────────────────────────────────────

/**
 * One post-install configuration prompt.
 *
 * Structurally matches the "prompt" arm of AIP-45 `AgentCliSetupStep`.
 * `persist.env` is the only persist form supported here (MVP): the captured
 * value is injected as an env var on every subsequent `ensure` call (T9).
 */
export interface BrowserAdapterConfigStep {
  id: string
  kind: "prompt"
  prompt: string
  description?: string
  type?: "text" | "select" | "boolean" | "secret"
  default?: string
  options?: string[]
  /** Where the captured value lands so `ensure` can reuse it. */
  persist?: {
    /** Env-var name to inject on every spawn. */
    env: string
  }
}

// ─── Requires ─────────────────────────────────────────────────────────────────

/** Platform constraints for this adapter. */
export interface BrowserAdapterRequires {
  /**
   * Hard OS constraint: the adapter is **unavailable** on platforms not listed
   * here (Node `process.platform` values, e.g. `"linux"`).  Absence means the
   * adapter is available everywhere.
   */
  os?: string[]
  /** Allowed CPU architectures (Node `process.arch` values). */
  arch?: string[]
  /**
   * OS platforms on which the **native launcher path** (e.g. launchd plist) is
   * available.  This is NOT a hard availability constraint — the adapter still
   * works on other platforms when a `SERVE_CMD` env var or `opts.launchCmd`
   * override is provided.  Absence means no platform-specific native launcher.
   */
  nativeLaunchOs?: string[]
}

// ─── Options ──────────────────────────────────────────────────────────────────

/** Minimal subset of AIP-45 `AgentCliOption` — typed runtime knob. */
export interface BrowserAdapterOption {
  id: string
  type: "boolean" | "integer" | "string" | "enum"
  description?: string
  /** Required when type === "enum". */
  enum?: string[]
  default?: boolean | number | string
  /** Env vars to merge when the option is active. */
  env?: Record<string, string>
}

// ─── Start options ────────────────────────────────────────────────────────────

export interface BrowserAdapterStartOptions {
  port?: number
  /** For adapters that depend on Camofox (e.g. bureau): override the Camofox port (default 9377). */
  camofoxPort?: number
  /** Override the launch command (shell string). Takes precedence over env vars. */
  launchCmd?: string
  /** Additional env vars forwarded to the spawned process. */
  env?: Record<string, string>
  timeoutMs?: number
  log?: (s: string) => void
  /**
   * Where to run the adapter.  Defaults to `handle.location ?? "local"`.
   * - `"local"` — spawn the process on the current machine (existing behaviour).
   * - `"cloud"` — health-check a remote endpoint; no process is spawned.
   *   Requires `baseUrl` to be set.
   */
  location?: "local" | "cloud"
  /**
   * Base URL of the remote service when `location === "cloud"`.
   * Example: `"https://browser-service.example.com"`.
   * Required (and only used) when `location === "cloud"`.
   */
  baseUrl?: string
  /**
   * Override the binary path used for the local spawn.
   * When set, takes precedence over the adapter's own resolved binary path.
   * Only used on the local path (`location !== "cloud"`).
   */
  binPath?: string
  /**
   * Opt-in non-blocking cold start. When set, `ensure` waits only this many
   * milliseconds for the freshly-spawned service to become healthy. If it does
   * not, `ensure` returns promptly with `status: "starting"` while health
   * convergence continues in the background. When unset (default), `ensure`
   * blocks up to `timeoutMs` (existing behaviour).
   */
  initialWaitMs?: number
  /**
   * `chrome-live` only; every other adapter ignores this. `"dedicated"`
   * (default) launches/reuses the dedicated, zero-consent Chrome.
   * `"personal"` attaches to the user's own, logged-in Chrome instead (the
   * remote debugging toggle, consent click included) — maps to
   * `attachIntent: true` on the chrome-live launch options.
   */
  profile?: "dedicated" | "personal"
  /**
   * `chrome-live` only; every other adapter ignores this. The real Chrome
   * profile directory (`Default`, `Profile 1`, …) a configured
   * `cookieSource` should trace injected cookies back to. Pure passthrough —
   * this package has no opinion on what it means or who may set it.
   */
  chromeProfile?: string
  /**
   * `chrome-live` only; every other adapter ignores this. Narrows which
   * domains' cookies a configured `cookieSource` injects into the dedicated
   * Chrome — an AND on top of whatever the source already scopes to, never
   * a widening. Pure passthrough.
   */
  domains?: readonly string[]
}

// ─── Instance ─────────────────────────────────────────────────────────────────

export interface BrowserAdapterInstance {
  id: string
  port: number
  baseUrl: string
  /**
   * PID of the spawned process. May be `undefined` when the service is managed
   * externally (e.g. launchd) — do NOT use this to kill the process in that case.
   */
  pid?: number
  wasAlreadyRunning: boolean
  /**
   * Whether the service is confirmed healthy at return time. Always true on
   * the warm path and on a blocking cold start. Only `false` when
   * `opts.initialWaitMs` was set and the service had not converged within the
   * bounded window — health-wait continues in the background and
   * `browser_status` / `list_browsers` will flip it to running once up.
   */
  healthy: boolean
  /** Optional health probe for providers whose health is not an HTTP endpoint. */
  health?(): Promise<{ ok: boolean; reason?: string }>
  /** Optional capture on a provider-owned target. */
  screenshot?(tabId?: string): Promise<{ data: string; format: "png" | "jpeg"; width?: number; height?: number }>
  /** Optional navigate on a provider-owned target (chrome-live): reuses an existing owned tab, or opens one. */
  navigate?(url: string, tabId?: string): Promise<{ targetId: string; url: string }>
  /** Optional serialized DOM of a provider-owned target (chrome-live). Throws when no owned tab is open yet. */
  getDom?(tabId?: string): Promise<{ targetId: string; url: string; html: string }>
  /** Optional click by CSS selector on a provider-owned target (chrome-live). Throws when no owned tab is open yet, or no element matches. */
  click?(
    options: { selector: string; button?: "left" | "middle" | "right"; clickCount?: number },
    tabId?: string
  ): Promise<void>
  /** Optional fill (focus + type) by CSS selector on a provider-owned target (chrome-live). Throws when no owned tab is open yet, or no element matches. */
  fill?(options: { selector: string; value: string; clear?: boolean }, tabId?: string): Promise<void>
  /** Optional JS evaluate on a provider-owned target (chrome-live). */
  evaluate?<T = unknown>(
    options: { expression: string; awaitPromise?: boolean; returnByValue?: boolean; maxResultBytes?: number },
    tabId?: string
  ): Promise<{ value: T | undefined; truncated: boolean }>
  /** Optional scroll on a provider-owned target (chrome-live): a CSS selector into view, or the window to an absolute `{x, y}`. */
  scroll?(options: { selector?: string; x?: number; y?: number }, tabId?: string): Promise<{ targetId: string }>
  /** Optional CDP screencast over a provider-owned tab (chrome-live). Frames come base64-encoded. */
  screencastStart?(opts?: { format?: "jpeg" | "png"; quality?: number; everyNthFrame?: number; maxWidth?: number; maxHeight?: number }): Promise<{ targetId: string; index: number }>
  screencastFrame?(): Promise<{ data: string; format: "jpeg" | "png"; timestampMs: number; index: number; width?: number; height?: number } | null>
  screencastStop?(): Promise<{ targetId: string | undefined; frameCount: number; total: number; frames: Array<{ data: string; format: "jpeg" | "png"; timestampMs: number; index: number; width?: number; height?: number }> }>
  /**
   * Best-effort stop. Sends SIGTERM to `pid` if known; otherwise a no-op
   * (externally-managed services must be stopped via their own manager).
   */
  stop(): Promise<void>
}
