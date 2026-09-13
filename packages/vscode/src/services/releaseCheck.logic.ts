/**
 * Release-check pure decision logic — now shared with the CLI via
 * `@agentproto/runtime/release-check` (both this package and the CLI already
 * depend on `@agentproto/runtime`, so that package is the single home for the
 * comparison/cache/IO logic). This file is a thin re-export so existing
 * private imports (`./releaseCheck.logic.js`) and its tests keep working
 * unchanged; the real logic lives in the runtime package.
 */

export * from "@agentproto/runtime/release-check"