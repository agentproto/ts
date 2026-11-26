---
"@agentproto/app": patch
"@agentproto/runtime": patch
---

Allow caller-provided `driverCtx.secrets` to satisfy `DRIVER.md` `auth.state.env` before falling back to `process.env` in `loadAppBundledTools` (with snake_case fallback for `metadata.http`), forward scoped `secrets` / `resolveSecrets` through `runBundledAppTool` and `performExposedToolCall`, and invalidate the cached `internalToolServerPromise` on `app_install`, `app_resync` (when changed), `app_uninstall`, and `routine_reconcile` so newly installed or updated apps' exposed tools are immediately dispatchable without a daemon restart.
