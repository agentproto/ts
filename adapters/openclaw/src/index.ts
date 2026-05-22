/**
 * @agentproto/adapter-openclaw — AIP-45 adapter for OpenClaw.
 *
 * OpenClaw exposes a native ACP bridge: `openclaw acp` speaks ACP over
 * stdio and forwards prompts to the OpenClaw Gateway over WebSocket.
 * Unlike claude-code / opencode / codex which run in pure-npx mode,
 * OpenClaw needs a one-time onboarding step (`openclaw onboard
 * --install-daemon`) so the local Gateway service and auth config exist.
 * Hosts can inject remote Gateway credentials per spawn, but the default
 * path relies on OpenClaw's persisted local config.
 *
 *   import { openclaw, openclawRuntime } from "@agentproto/adapter-openclaw"
 *   const session = await openclawRuntime().start({
 *     env: {
 *       OPENCLAW_GATEWAY_URL: "wss://gateway:18789",
 *       OPENCLAW_GATEWAY_TOKEN: "...",
 *     },
 *   })
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

export const openclaw: AgentCliHandle = defineAgentCli({
  name: "openclaw",
  id: "openclaw",
  description:
    "OpenClaw — coding-agent platform with a native plugin surface and built-in ACP bridge. `openclaw acp` exposes a Gateway session as an ACP server over stdio JSON-RPC; an external host drives prompts and the bridge forwards them to the OpenClaw Gateway over WebSocket. Requires an onboarded local Gateway service, or explicit remote Gateway URL/token injection on spawn.",
  version: "0.1.0",
  bin: "openclaw",
  bin_args: ["acp"],
  install: [
    { method: "curl", url: "https://openclaw.ai/install.sh" },
    {
      method: "npm",
      package: "openclaw",
      global: true,
      experimental: true,
    },
  ],
  version_check: {
    cmd: "openclaw --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.1.0",
    timeout_ms: 5_000,
  },
  // AIP-29 § Setup — post-install configuration. OpenClaw 2026.x stores
  // Gateway auth under `gateway.auth.*` for the local service; remote
  // Gateway URL/token injection remains available through runtime options.
  // `openclaw acp --probe` no longer exists, so setup uses the Gateway
  // probe as the idempotent readiness check.
  setup: [
    {
      id: "install-daemon",
      kind: "cmd",
      cmd: "openclaw onboard --install-daemon",
      // `gateway status` can exit 0 even when launchd has a plist but the
      // service is not loaded. `gateway probe` fails until the ACP target
      // is actually reachable and write-capable.
      skip_if: { cmd: "openclaw gateway probe", exit_code: 0 },
      description:
        "Installs and starts the OpenClaw local Gateway service (one-time per host).",
      // Onboard prints a TUI progress; attach a PTY so the user can
      // see the steps and any prompts the daemon installer raises.
      interactive: true,
      timeout_ms: 300_000,
    },
    {
      id: "ready-check",
      kind: "cmd",
      cmd: "openclaw gateway probe",
      description:
        "Confirms the OpenClaw Gateway is reachable and write-capable.",
      timeout_ms: 30_000,
    },
  ],
  auth: {
    ref: "./SECRETS.md",
    state: {
      env: [
        "OPENCLAW_GATEWAY_URL",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
      ],
    },
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./openclaw-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    // OpenClaw plugins can register sub-agents (per the tools/plugin
    // docs — `registerProvider`, `registerChannel`, etc.)
    sub_agents: true,
    file_io: true,
    multimodal: true,
    // The bridge advertises sessionCapabilities `list`, `resume`,
    // `close` per the protocol smoke test.
    resumable: true,
    bidirectional: true,
  },
  modes: [
    {
      id: "default",
      description:
        "Standard interactive mode — bridge forwards prompts to the configured Gateway session.",
    },
  ],
  options: [
    {
      id: "gateway_url",
      type: "string",
      description:
        "Gateway WebSocket URL override. Falls back to OPENCLAW_GATEWAY_URL or OpenClaw's persisted local config.",
      bin_args_template: ["--url", "{value}"],
    },
    {
      id: "token_file",
      type: "string",
      description:
        "Path to a file holding the Gateway bearer token. Alternative to OPENCLAW_GATEWAY_TOKEN env.",
      bin_args_template: ["--token-file", "{value}"],
    },
  ],
  continuation: {
    default: "pinned-session",
    supported: ["pinned-session", "transcript", "none"],
    pinned_session: {
      idle_timeout_ms: 1_800_000,
      key_scope: ["conversation", "operator"],
    },
  },
  tags: ["openclaw", "acp", "agent-runtime", "coding"],
})

export function openclawRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(openclaw)
}

export type { AgentCliHandle, AgentCliRuntime }
