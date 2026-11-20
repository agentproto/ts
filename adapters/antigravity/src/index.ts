/**
 * @agentproto/adapter-antigravity — AIP-44 adapter for Google Antigravity.
 *
 * Antigravity's CLI `agy` ships a first-party ACP server since 1.5.x:
 * `agy acp` (JSON-RPC 2.0 over stdio, protocolVersion 1; verified on 1.5.13).
 * So this is a `protocol: "acp"` arm. It replaces the earlier print/headless
 * arm (`agy -p --output-format stream-json`), written when ACP was only an
 * open feature request (google-antigravity/antigravity-cli#31).
 *
 *   import { antigravity, antigravityRuntime } from "@agentproto/adapter-antigravity"
 *   const session = await antigravityRuntime().start()
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 *
 * Wire profile: ./antigravity-acp.ACP.md. Auth: ./SECRETS.md.
 */

import {
  createAgentCliRuntime,
  defineHarness,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/harness"

export const antigravity: AgentCliHandle = defineHarness({
  name: "antigravity",
  id: "antigravity",
  description:
    "Google Antigravity's CLI (`agy acp`) — a multi-model coding agent " +
    "(Gemini 3.x, Claude, GPT-OSS) driven over the Agent Client Protocol.",
  version: "0.2.0",
  bin: "agy",
  // First-party ACP server over stdio (the default transport).
  bin_args: ["acp"],
  // Not on npm — the only documented install is the official curl installer,
  // which drops `agy` into ~/.local/bin (antigravity.google/docs/cli/headless).
  install: [
    { method: "curl", url: "https://antigravity.google/cli/install.sh" },
  ],
  // `agy --version` prints a bare semver (verified: "1.5.13"). `agy acp` is
  // verified on 1.5.13; the floor is that version.
  version_check: {
    cmd: "agy --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.5.13",
    timeout_ms: 15_000,
  },
  // Antigravity authenticates through the OS keyring + a Google Sign-In
  // browser flow ONLY — there is no documented API-key environment variable.
  // Headless runs reuse the cached credentials, so the user must have run
  // `agy` interactively once on this machine; a non-interactive run with no
  // cached login exits with an "authentication required" error. Nothing to
  // inject or scrub here — see ./SECRETS.md.
  auth: {
    ref: "./SECRETS.md",
  },
  // The Google Sign-In login (OS keyring, set by an interactive `agy` run) IS
  // the subscription. `external: true` declares that: the runtime injects NO
  // bearer — there is no env var to inject into — and `agy` reads its own
  // cached login. No api-key route exists, so there is nothing to scrub.
  authSubscription: { external: true },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./antigravity-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  // No `models` block by design. The docs' `agy models` output shows real
  // slugs (e.g. `gemini-3.5-flash-medium`, `claude-sonnet-4-6`), but the list
  // is version-dependent and only partially documented, and every model is
  // served through Antigravity's own backend under ONE Google identity — not
  // a per-provider api-key route the catalog could bill. Declaring a fixed
  // `models.allowed`/`provider` here would assert routing facts we haven't
  // verified; the honest surface is the free-form `model` option below, which
  // forwards any slug from `agy models` straight to `--model`.
  capabilities: {
    streaming: true,
    tool_calls: true,
    // agy runs subagents (`agy agents`, background tasks); step_updates carry
    // `subagent_info`. We don't surface each subagent as its own StreamEvent,
    // but the capability is real.
    sub_agents: true,
    file_io: true,
    // Unverified — declared false rather than overclaiming.
    multimodal: false,
    // `initialize` advertises loadSession + sessionCapabilities.resume.
    resumable: true,
    bidirectional: true,
  },
  options: [
    {
      id: "agent",
      type: "string",
      description:
        "Agent to run this prompt as (see `agy agents`). Forwarded to `--agent`.",
      bin_args_template: ["--agent", "{value}"],
    },
    {
      id: "dangerously_skip_permissions",
      type: "boolean",
      description:
        "Auto-approve EVERY tool call (file writes, command execution) for " +
        "this run via `--dangerously-skip-permissions`. Off by default; " +
        "prefer scoped `permissions.allow` rules in agy's settings.json.",
      bin_args_append_when_true: ["--dangerously-skip-permissions"],
    },
    {
      id: "terminal_sandbox",
      type: "boolean",
      description:
        "Run agy with its terminal sandbox restrictions enabled (`--sandbox`).",
      bin_args_append_when_true: ["--sandbox"],
    },
  ],
  continuation: {
    default: "none",
    supported: ["none", "transcript", "native-resume"],
  },
  metadata: {
    acp: {
      checked: "2026-11-20",
      result:
        "`agy acp` (Antigravity CLI 1.5.13) answers `initialize` with " +
        "protocolVersion 1, agentInfo \"Antigravity ACP Server\", loadSession, " +
        "sessionCapabilities {resume, close, load, list, additionalDirectories}, " +
        "promptCapabilities {image, embeddedContext} and authMethods " +
        "oauth-personal / oauth-business / gemini-api-key / agent-platform. " +
        "`session/new` without a cached login returns -32000 " +
        "\"Authentication required\". The session/prompt turn itself is NOT " +
        "verified end to end (no Google login was available when this was written).",
    },
    models: {
      checked: "2026-08-06",
      result:
        "`agy models` (per antigravity.google/docs/models + the headless docs) " +
        "lists slugs like gemini-3.6-flash-high, gemini-3.6-flash-medium, " +
        "gemini-3.5-flash-medium, gemini-3.1-pro-high, claude-sonnet-4-6 — " +
        "plus GPT-OSS variants. The full list is version-dependent and only " +
        "partially documented, so no fixed `models.allowed` is declared; pass " +
        "any slug through the `model` option.",
    },
    auth: {
      checked: "2026-08-06",
      result:
        "OS keyring + Google Sign-In browser flow only; no documented API-key " +
        "env var. Run `agy` interactively once to cache credentials before any " +
        "headless run.",
    },
  },
  tags: ["antigravity", "agy", "google", "acp", "agent-runtime", "coding"],
})

export function antigravityRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(antigravity)
}

export type { AgentCliHandle, AgentCliRuntime }
