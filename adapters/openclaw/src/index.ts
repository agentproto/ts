/**
 * @agentproto/adapter-openclaw — AIP-45 adapter for OpenClaw.
 *
 * OpenClaw exposes a native ACP bridge: `openclaw acp` speaks ACP over
 * stdio and forwards prompts to the OpenClaw Gateway over WebSocket.
 * Unlike claude-code / opencode / codex which run in pure-npx mode,
 * OpenClaw needs a one-time onboarding step (`openclaw onboard
 * --install-daemon`) and a configured Gateway URL + token before the
 * bridge can connect. Hosts inject `OPENCLAW_GATEWAY_URL` and
 * `OPENCLAW_GATEWAY_TOKEN` per spawn or rely on persisted config.
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
    "OpenClaw — coding-agent platform with a native plugin surface and built-in ACP bridge. `openclaw acp` exposes a Gateway session as an ACP server over stdio JSON-RPC; an external host drives prompts and the bridge forwards them to the OpenClaw Gateway over WebSocket. Requires onboarded daemon + persisted gateway URL/token (or env injection on spawn).",
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
  // AIP-29 § Setup — post-install configuration. OpenClaw needs three
  // things in order before `openclaw acp` can connect to a Gateway:
  //   1. The daemon installed and running.
  //   2. A Gateway URL configured (hosted default or self-hosted).
  //   3. A Gateway token persisted as an env var (or via `openclaw config`).
  // A 4th step round-trips the bridge to surface mis-configuration
  // before the operator wonders why no events arrive.
  setup: [
    {
      id: "install-daemon",
      kind: "cmd",
      cmd: "openclaw onboard --install-daemon",
      // skip_if asks the live system — works on fresh machines without
      // any local ledger state, and re-runs of `agentproto setup
      // openclaw` short-circuit when the daemon is already up.
      skip_if: { cmd: "openclaw daemon status", exit_code: 0 },
      description:
        "Installs and starts the OpenClaw background daemon (one-time per host).",
      // Onboard prints a TUI progress; attach a PTY so the user can
      // see the steps and any prompts the daemon installer raises.
      interactive: true,
      timeout_ms: 300_000,
    },
    {
      id: "gateway-url",
      kind: "prompt",
      prompt: "Gateway URL (Enter for hosted default)",
      default: "wss://gateway.openclaw.ai",
      description:
        "WebSocket URL of the Gateway your acp bridge will forward prompts to.",
      // skip_if reads the persisted config — re-runs don't re-prompt
      // when the URL is already set.
      skip_if: {
        cmd: "openclaw config get gateway.remote.url",
        exit_code: 0,
      },
      persist: { env: "OPENCLAW_GATEWAY_URL" },
    },
    {
      id: "gateway-token",
      kind: "prompt",
      type: "secret",
      prompt: "Gateway token (paste from https://openclaw.ai/dashboard)",
      description:
        "Bearer token for the gateway session. Stored masked; never echoed back.",
      skip_if: {
        cmd: "openclaw config get gateway.remote.token",
        exit_code: 0,
      },
      persist: { env: "OPENCLAW_GATEWAY_TOKEN" },
    },
    {
      id: "ready-check",
      kind: "cmd",
      cmd: "openclaw acp --probe",
      description:
        "Round-trips the bridge to confirm the gateway is reachable.",
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
        "Gateway WebSocket URL override. Falls back to OPENCLAW_GATEWAY_URL or persisted config.",
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
