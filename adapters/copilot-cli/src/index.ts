/**
 * @agentproto/adapter-copilot-cli — AIP-45 adapter for GitHub Copilot CLI.
 *
 * GitHub Copilot CLI (binary `copilot`, product name "GitHub Copilot CLI") is
 * GitHub's official terminal coding agent — https://github.com/github/copilot-cli,
 * docs at
 * https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli.
 *
 * It ships a FIRST-PARTY ACP server, so — like the `grok-cli` adapter — this is
 * a `protocol: "acp"` arm, not a print/headless one. `copilot --acp --stdio`
 * speaks Agent Client Protocol JSON-RPC 2.0 as NDJSON over stdio (verified
 * against the official docs at
 * https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server;
 * ACP was added in 0.0.397 on 2026-01-28 and is in public preview). The server
 * exposes model and reasoning-effort ACP session config options and supports
 * loading existing sessions.
 *
 * A headless one-shot surface also exists — `copilot -p "<prompt>"
 * --output-format json` emits JSONL — but the ACP arm is the richer, persistent,
 * resumable posture, and it avoids a bespoke print event mapper in the driver.
 *
 *   import { copilotCli, copilotCliRuntime } from "@agentproto/adapter-copilot-cli"
 *   const session = await copilotCliRuntime().start({
 *     env: { GH_TOKEN: "github_pat_..." },
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

export const copilotCli: AgentCliHandle = defineAgentCli({
  name: "copilot-cli",
  id: "copilot-cli",
  description:
    "GitHub's official Copilot CLI (`copilot --acp --stdio`) — a terminal coding agent driving GitHub-hosted models (Claude, GPT, Gemini, Grok, …) over the Agent Client Protocol. Works with github.com and GitHub Enterprise (GH_HOST).",
  version: "0.1.0",
  bin: "copilot",
  // First-party ACP server over stdio (the default transport when `--acp` is
  // set; `--stdio` is passed explicitly to disambiguate from TCP `--port`).
  bin_args: ["--acp", "--stdio"],
  install: [
    { method: "npm", package: "@github/copilot", global: true },
    { method: "brew", package: "copilot-cli" },
    { method: "curl", url: "https://gh.io/copilot-install" },
  ],
  version_check: {
    // `copilot --version` / `-v` prints version information. The ACP server
    // landed in 0.0.397 (2026-01-28); ACP session LOAD — the resume surface
    // this adapter's `native-resume` continuation rides on — landed in 0.0.410
    // (2026-02-14), so that is the floor. The exact stdout shape is UNVERIFIED
    // (the CLI is not installed in this worktree), so the parse is the
    // conventional semver grab.
    cmd: "copilot --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.0.410",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    // Documented token precedence: COPILOT_GITHUB_TOKEN > GH_TOKEN >
    // GITHUB_TOKEN (github.com and ghe.com subdomains). GitHub Enterprise
    // Server uses GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN. Supported
    // token types: OAuth (`gho_`), fine-grained PAT with the "Copilot
    // Requests" permission (`github_pat_`), and GitHub App user-to-server
    // (`ghu_`). Classic PATs (`ghp_`) are NOT supported.
    state: {
      env: [
        "COPILOT_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
      ],
    },
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./copilot-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  // No `models` block by design: the model menu is plan/entitlement-dependent
  // and served under ONE GitHub identity (not a per-provider api-key route the
  // catalog could bill), and the exact `--model` slugs are not documented in a
  // stable table. The honest surface is the free-form `model` option below,
  // which the ACP arm applies via the `model` session config option; the CLI
  // validates explicit ids against the account. `models.apply` therefore
  // defaults to `"config"` (ACP set_config_option), and no catalog `provider`
  // is declared — Copilot bills through the GitHub subscription, not a
  // provider API key.
  capabilities: {
    streaming: true,
    tool_calls: true,
    // The ACP server reports subagent activity to its client, but that is the
    // agent's own internal delegation, not an AIP-45 `sub_agents` surface —
    // declared false, same posture as grok-cli.
    sub_agents: false,
    file_io: true,
    // The ACP `promptCapabilities` for this server are not documented; declared
    // false rather than overclaiming (the interactive CLI does accept pasted
    // images, but that is not an ACP content-block channel).
    multimodal: false,
    // ACP session load (0.0.410+) backs the `native-resume` continuation.
    resumable: true,
    bidirectional: true,
  },
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Copilot model id for this session (e.g. `claude-sonnet-4.5`, `gpt-5`, " +
        "`auto`). Applied via the ACP `model` session config option; the CLI " +
        "validates the id against your plan/entitlements and rejects an unknown one.",
    },
    {
      id: "effort",
      type: "enum",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description:
        "Reasoning effort for this session. Applied via the ACP `effort` session " +
        "config option (the server also accepts `--effort`/`--reasoning-effort` at start).",
    },
    {
      id: "github_host",
      type: "string",
      description:
        "GitHub hostname for GitHub Enterprise — GHEC with data residency " +
        "(e.g. `example.ghe.com`) or a GHES host. Sets `GH_HOST`; pair with " +
        "`GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` for GitHub Enterprise Server.",
      env: { GH_HOST: "{value}" },
    },
  ],
  continuation: {
    default: "native-resume",
    supported: ["native-resume", "pinned-session", "transcript", "none"],
    pinned_session: {
      idle_timeout_ms: 1_800_000,
      key_scope: ["conversation", "operator"],
    },
  },
  metadata: {
    acp: {
      checked: "2026-10-01",
      result:
        "GitHub Copilot CLI ships a first-party ACP server: `copilot --acp --stdio` " +
        "(NDJSON JSON-RPC 2.0 over stdio; TCP via `--acp --port`). Added in 0.0.397 " +
        "(2026-01-28), public preview. The server exposes model and reasoning-effort " +
        "ACP session config options and supports loading existing sessions (0.0.410+). " +
        "This adapter drives ACP, not the print/headless surface.",
    },
    print: {
      checked: "2026-10-01",
      result:
        "A headless one-shot surface also exists: `copilot -p \"<prompt>\" " +
        "--output-format json` emits JSONL, with `--model`, `--resume[=ID]`, " +
        "`--allow-all-tools`, `--stream`, and `--share-gist`. Not wired here — " +
        "ACP is the richer posture and avoids a bespoke print event mapper.",
    },
    auth: {
      checked: "2026-10-01",
      result:
        "Token env precedence: COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN. " +
        "GitHub Enterprise Cloud (data residency) uses `copilot login --host` or " +
        "GH_HOST + a token; GitHub Enterprise Server uses GH_HOST + " +
        "GH_ENTERPRISE_TOKEN/GITHUB_ENTERPRISE_TOKEN (or the COPILOT_PROVIDER_GHES_* " +
        "vars). BYOK (COPILOT_PROVIDER_BASE_URL/TYPE/API_KEY/MODEL) can run without " +
        "a GitHub login — not wired here.",
    },
  },
  tags: ["copilot", "github", "acp", "agent-runtime", "coding", "enterprise"],
})

export function copilotCliRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(copilotCli)
}

export type { AgentCliHandle, AgentCliRuntime }
