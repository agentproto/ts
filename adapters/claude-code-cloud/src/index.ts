/**
 * @agentproto/adapter-claude-code-cloud — AIP-66 managed cloud agent adapter
 * for Anthropic Claude Code cloud sessions.
 *
 * Unlike `@agentproto/adapter-claude-code` (local harness, host machine),
 * this adapter relays a session the VENDOR hosts end to end: the vendor
 * boots the machine, runs Claude Code in it, and exposes the session
 * through `claude --cloud` / `claude -p --cloud` plus the undocumented
 * Claude Code sessions API. No agentproto daemon runs inside; the host
 * controls neither the machine nor the harness — so this manifest is
 * deliberately smaller and refuses the spawn fields that could never take
 * effect (AIP-66 §4).
 *
 *   import { claudeCodeCloud } from "@agentproto/adapter-claude-code-cloud"
 */

import { fileURLToPath } from "node:url"
import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

// Self-locating: the built handle spawns `node <this-pkg>/bin/…
// claude-code-cloud-acp.mjs`. From dist/index.mjs the bin sits one level up,
// so the same build works whether the daemon resolves this package from
// node_modules or a user runs the published bin directly.
const acpBin = fileURLToPath(
  new URL("../bin/claude-code-cloud-acp.mjs", import.meta.url),
)

// AIP-66 §4 refused spawn fields — no meaning for a vendor-owned harness, so
// the host MUST refuse a cloud spawn that sets any of them rather than
// ignore them. Documented here (and in CLAUDE-CODE-CLOUD.md) so the runtime
// gate and users share one list.
export const CLOUD_REFUSED_SPAWN_FIELDS = [
  "sandbox",
  "worktree",
  "commandSandbox",
  "mcpServers",
  "daemonMount",
  "bundles",
  "browser",
  "appServe",
  "inference",
] as const

export const claudeCodeCloud: AgentCliHandle = defineAgentCli({
  name: "claude-code-cloud",
  id: "claude-code-cloud",
  description:
    "AIP-66 managed cloud agent adapter for Anthropic Claude Code cloud " +
    "sessions. The vendor owns the machine and the harness: starts via " +
    "`claude --cloud` (TTY), prompts via `claude -p --cloud <id>`, observes " +
    "via the Claude Code sessions API, projected onto stdio ACP. Refuses " +
    "the AIP-66 §4 spawn fields (sandbox, worktree, commandSandbox, " +
    "mcpServers, daemonMount, bundles, browser, appServe, inference) — the " +
    "vendor can never apply them. Requires a claude.ai sign-in (API-key " +
    "auth is refused) and a clean, pushed git checkout.",
  version: "0.1.0",
  bin: "node",
  bin_args: [acpBin],
  install: [
    {
      method: "npm",
      package: "@agentproto/adapter-claude-code-cloud",
      global: true,
    },
  ],
  // Presence probe against the vendor client this adapter relays to — the
  // pinned floor is the oldest CLI observed to support `--cloud` / the
  // sessions API (AIP-66 Appendix A: 2.1.296–2.1.299).
  version_check: {
    cmd: "claude --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=2.1.296",
    timeout_ms: 15_000,
  },
  // Auth is the user's OWN claude.ai login inside the claude CLI (keychain
  // on macOS) — never an injected env credential (AIP-66 §8). No `state.env`
  // because an API-key env would be scrubbed, not consumed; the preflight
  // refuses an api_key-authenticated CLI outright.
  auth: {
    ref: "./CLAUDE-CODE-CLOUD.md",
    login: {
      cmd: "claude auth login",
      interactive: true,
    },
  },
  // The machine is the vendor's; there is no host-side sandbox to describe.
  sandbox:
    "Managed cloud (AIP-66): the vendor boots the machine and runs Claude " +
    "Code on it. No agentproto daemon runs inside; the session URL is " +
    "surfaced so the user can inspect what ran.",
  protocol: "acp",
  acp: "./CLAUDE-CODE-CLOUD.md",
  session: {
    // One agentproto session = one vendor cloud session (AIP-66 §5);
    // follow-up turns send to the same vendor session.
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  // NO `models` menu: the vendor picks and bills the model inside its own
  // harness; the host has no model to select or route (AIP-66 §4 — `model`
  // is only meaningful when the vendor client accepts it, and this CLI's
  // cloud path exposes no model flag).
  capabilities: {
    // Turns stream back as ACP updates while the vendor runs them.
    streaming: true,
    // The vendor harness's own tools (Read/Edit/Bash/…) surface as ACP
    // tool_call / tool_call_update updates from the session's events.
    tool_calls: true,
    sub_agents: false,
    file_io: true,
    multimodal: false,
    // Re-attach is via the persisted vendor session id (AIP-66 §5), not an
    // ACP session/load replay.
    resumable: true,
    // Send-only prompting: the CLI never returns the reply on the prompt
    // path; the reply is observed via the sessions API.
    bidirectional: false,
  },
  tags: [
    "claude-code",
    "anthropic",
    "cloud",
    "aip-66",
    "acp",
    "agent-runtime",
    "coding",
  ],
  metadata: {
    aip: 66,
    // The harness the vendor runs (AIP-66 §2 CloudVendor.harnesses).
    harness: "claude-code",
    cloud: {
      vendor: "anthropic",
    },
    // AIP-66 §4 refused spawn fields, machine-readable for the host gate.
    refusedSpawnFields: [...CLOUD_REFUSED_SPAWN_FIELDS],
  },
})

export function claudeCodeCloudRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(claudeCodeCloud)
}

export {
  ClaudeCloudAcpAgent,
  runAcpOverStdio,
  resultEventUpdates,
  resultStopReason,
  POLL_INITIAL_MS,
  POLL_MAX_MS,
  type ClaudeCloudAcpDeps,
  type CloudCliDeps,
  type CloudEventsClient,
} from "./acp-server.js"
export {
  cloudChildEnv,
  defaultCloudCliRunner,
  parseAuthStatus,
  parseCloudStartOutput,
  preflightAuth,
  sendPrompt,
  startCloudSession,
  CLAUDE_CODE_GATEWAY_ENV_UNSET,
  type AuthStatus,
  type CloudCliRunner,
  type RunOpts,
  type RunResult,
  type StartedCloudSession,
} from "./cli.js"
export {
  SessionsApi,
  envCredentialSource,
  keychainCredentialSource,
  normalizeSessionId,
  toCliSessionId,
  type CloudCredential,
  type CloudEventsPage,
  type CloudGetSessionResponse,
  type CloudSessionEvent,
  type CloudSessionState,
  type CloudSessionSummary,
  type CredentialSource,
  type SessionsApiOptions,
} from "./sessions-api.js"
export {
  validateRepoSource,
  defaultGitRunner,
  type GitRunner,
} from "./repo-source.js"
export type { AgentCliHandle, AgentCliRuntime }
