/**
 * Release-check IO (npm fetch + `~/.agentproto/release-check.json` cache).
 * Shared with the CLI via `@agentproto/runtime/release-check` (see
 * releaseCheck.logic.ts for why). Thin re-export so existing private imports
 * and tests keep working — the real logic lives in the runtime package.
 */

export * from "@agentproto/runtime/release-check"