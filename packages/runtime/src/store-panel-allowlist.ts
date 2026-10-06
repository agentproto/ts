/**
 * The store panel's OWN tool allowlist (`ui.tools`) — consumed by
 * `resolveBuiltinPanelUi` and performed against the
 * `POST /apps/:appId/tool-call` bridge (app-tools.ts
 * `performBuiltinPanelToolCall`). Read paths + the apply paths the store
 * UI drives directly; everything else stays out. `app_apply` exists on
 * main but is NOT in the panel's scope — applying to a scope is an
 * operator verb, not a store-shelf action.
 */
export const STORE_UI_TOOLS = [
  "app_catalog",
  "app_list",
  "app_install",
  "app_resync",
  "app_updates",
  "app_uninstall",
  "app_status",
] as const
