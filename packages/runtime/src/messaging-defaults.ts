/**
 * Per-call resolver for the three `config.json` `defaults` knobs that gate
 * inter-session messaging: `defaults.agentPromptInterrupt`,
 * `defaults.messaging.allowSiblings`, `defaults.messaging.agentInterrupt`.
 *
 * These used to be read ONCE at gateway boot (`index.ts`'s `configDefaults`,
 * captured before the `/mcp` and `/mcp/orchestrator` server factories were
 * built) and then closed over as static booleans/enums for the lifetime of
 * the daemon — so a `config_set` change never took effect without a
 * restart, unlike every other spawn-time `defaults.*` key (which
 * `session-spawn.ts` already re-reads per spawn). Both MCP gateways rebuild
 * their `McpServer` from scratch on EVERY request (the SDK's stateless
 * pattern — see `serveMcp` in `http-server.ts`), so calling this resolver
 * inside each factory, instead of reusing a boot-time snapshot, is all
 * "hot" requires: the very next `agent_prompt` / `message_parent` /
 * `message_send` / `message_reply` call already runs through a fresh
 * `McpServer` build.
 *
 * Mirrors the read-per-call discipline of `spawn-attach.ts` /
 * `spawn-dedupe.ts` / `worktree-isolation.ts` — no caching: `loadConfig` is
 * a small file read and is already called this often elsewhere.
 */

import { loadConfig } from "./config.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

export interface ResolvedMessagingDefaults {
  /** `defaults.agentPromptInterrupt` — the unset-default for `interrupt` on
   *  `agent_prompt` / `message_parent`. Default false. */
  agentPromptInterrupt: boolean
  /** `defaults.messaging.allowSiblings` — lets `message_send` /
   *  `message_reply` reach a sibling (same parent). Default false. */
  allowSiblings: boolean
  /** `defaults.messaging.agentInterrupt` — whether a SESSION sender's
   *  `interrupt` may cancel the recipient's turn. Default "deny". */
  agentInterrupt: "allow" | "deny"
}

/** Same unset-defaults as before this resolver existed — a missing/malformed
 *  config.json (or a `loadCfg` that throws) falls through to these, never
 *  a thrown error. */
export const DEFAULT_MESSAGING_DEFAULTS: ResolvedMessagingDefaults = {
  agentPromptInterrupt: false,
  allowSiblings: false,
  agentInterrupt: "deny",
}

export async function resolveMessagingDefaults(
  loadCfg: () => Promise<{ defaults?: SpawnDefaultsConfig }> = loadConfig,
): Promise<ResolvedMessagingDefaults> {
  try {
    const d = (await loadCfg()).defaults
    return {
      agentPromptInterrupt: d?.agentPromptInterrupt ?? DEFAULT_MESSAGING_DEFAULTS.agentPromptInterrupt,
      allowSiblings: d?.messaging?.allowSiblings ?? DEFAULT_MESSAGING_DEFAULTS.allowSiblings,
      agentInterrupt: d?.messaging?.agentInterrupt ?? DEFAULT_MESSAGING_DEFAULTS.agentInterrupt,
    }
  } catch {
    return DEFAULT_MESSAGING_DEFAULTS
  }
}
