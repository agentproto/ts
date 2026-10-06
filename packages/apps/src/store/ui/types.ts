/**
 * Local mirror of the app-store surfaces the daemon exposes over the MCP
 * bridge (packages/runtime/src/app-tools.ts / app-catalog.ts). Deliberately
 * NOT imported from @agentproto/runtime — this package stays
 * dependency-isolated from the daemon (same shape convention as
 * work-board/ui/types.ts); only what the UI renders is modelled.
 */

/** Entry of the local + remote app_catalog listings (app-catalog.ts). */
export interface CatalogRow {
  appId: string
  name?: string
  description?: string
  category?: string
  installed?: boolean
  hasUi?: boolean
  /** Remote entries: where the app comes from (the `app_install` payload). */
  source?: { kind: string } & Record<string, unknown>
  origin?: string
  catalogUrl?: string
  version?: string
  tier?: string
  publisher?: string
  placement?: string
  requires?: {
    agentprotoVersion?: string
    apps?: string[]
    agents?: string[]
  }
  featured?: boolean
  stale?: boolean
  updateAvailable?: boolean
  installedVersion?: string
}

/** One installed app of `app_list` (compact fields only). */
export interface InstalledRow {
  appId: string
  name?: string
  version?: string
  description?: string
  dir?: string
  dataDir?: string
  source?: { kind: string } & Record<string, unknown>
  dirMissing?: boolean
}

/** One update of `app_updates`. */
export interface UpdateRow {
  appId: string
  from?: Record<string, unknown>
  to?: Record<string, unknown>
  catalogUrl?: string
  stale?: boolean
}

/** What the mounted builtin tool answers (store/index.ts
 *  `StoreSnapshot`). Empty rows never render as a blank page — see main.ts
 *  storeEmpty(). */
export interface StoreSnapshot {
  catalog: CatalogRow[]
  installed: InstalledRow[]
  updates: UpdateRow[]
  warnings?: string[]
}

/** `app_install`'s confirmation handshake (app-tools.ts
 *  `appInstallConfirmation`). First tool call → `{needsConfirmation, ...}`;
 *  second call with the SAME payload + `confirm: <shaTip>` installs. */
export interface InstallConfirmationRequest {
  needsConfirmation: true
  confirm: string
  kind: "agentapp" | "git"
  url: string
  sha256?: string
  sha?: string
  ref?: string
  subdir?: string
  runsBuildCommand?: boolean
}
