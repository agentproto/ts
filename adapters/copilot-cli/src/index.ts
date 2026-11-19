/**
 * @agentproto/adapter-copilot-cli — AIP-45 harness for GitHub Copilot CLI.
 *
 * GitHub Copilot CLI (binary `copilot`, product name "GitHub Copilot CLI") is
 * GitHub's official terminal coding agent — https://github.com/github/copilot-cli,
 * docs at
 * https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli.
 *
 * It ships a FIRST-PARTY ACP server, so — like the `grok-cli` harness — this is
 * a `protocol: "acp"` arm, not a print/headless one. `copilot --acp --stdio`
 * speaks Agent Client Protocol JSON-RPC 2.0 as NDJSON over stdio (verified
 * against the official docs at
 * https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
 * and live against CLI 1.0.113 on 2026-11-18; ACP was added in 0.0.397 on
 * 2026-01-28). The server exposes `model`, `reasoning_effort` and `mode`
 * (agent / plan / autopilot) ACP session config options and supports loading
 * existing sessions. It does NOT advertise `_meta.steering`: a second
 * `session/prompt` during a turn cancels the first (`stopReason: cancelled`).
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
  defineHarness,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/harness"
import { copilotCliNativeHooks } from "./native-hooks.js"

const COPILOT_MODELS = [
  "auto",
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-haiku-5.5",
  "claude-haiku-4.5",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "mai-code-1.1-flash",
  "mai-code-2-flash",
  "mai-code-2",
  "gemini-3.8-flash",
  "gemini-4-hydrogen",
  "grok-4.7",
  "grok-4.6",
  "kimi-k3",
] as const

export const copilotCli: AgentCliHandle = defineHarness({
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
    // this harness's `native-resume` continuation rides on — landed in 0.0.410
    // (2026-02-14), so that is the floor. Verified on 1.0.113: the CLI prints
    // "GitHub Copilot CLI 1.0.113." and the semver grab parses it.
    cmd: "copilot --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.0.410",
    timeout_ms: 15_000,
  },
  // npm is the first declared install channel, so the npm shape is the
  // upgrade story: latest from the registry, in-place reinstall, exact-
  // version rollback for a failed post-upgrade ACP smoke probe.
  upgrade: {
    latest: { npm: "@github/copilot" },
    cmd: ["npm", "i", "-g", "@github/copilot@latest"],
    rollback: ["npm", "i", "-g", "@github/copilot@{version}"],
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
  // Copilot bills through the user's GitHub Copilot subscription, and the
  // `copilot` CLI owns that login (`copilot login` → system keychain, or
  // `~/.copilot/config.json`; `gh auth token` as a last fallback). `external:
  // true` declares exactly that: the runtime injects NO bearer and the CLI
  // reads its own stored login. The token env vars in `auth.state` above are
  // the same GitHub identity, not a per-token API-billing route, so there is
  // no api-key var to scrub (no `conflictEnv`).
  authSubscription: { external: true },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./copilot-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  // Curated model menu, read from a real `session/new` (`models.availableModels`
  // and the `model` config option) on CLI 1.0.113, account with Copilot Pro,
  // 2026-11-18. The menu is plan/entitlement-dependent and served under ONE
  // GitHub identity, so `allowed` is only a menu (the free-form `model` option
  // still accepts any id; the CLI validates it against the account) and no
  // catalog `provider` is declared — Copilot bills through the GitHub
  // subscription (premium-request multipliers), not a provider API key.
  // `claude-haiku-4.5` is 0.33x and `gemini-3.8-flash` is 14x on that account.
  // The live list for a given account is what the session returns at
  // `session/new` (`availableConfigOptions` on the ACP session).
  models: {
    default: "claude-sonnet-5.5",
    allowed: [...COPILOT_MODELS],
    apply: "config",
  },
  capabilities: {
    // `session_command_self` allow-list (see harness types). The daemon also
    // requires the command to be in the session's live `availableCommands`.
    selfCommands: ["compact"],
    streaming: true,
    tool_calls: true,
    // The ACP server reports subagent activity to its client, but that is the
    // agent's own internal delegation, not an AIP-45 `sub_agents` surface —
    // declared false, same posture as grok-cli.
    sub_agents: false,
    file_io: true,
    // Verified live on 1.0.113: `promptCapabilities.image` is true and a
    // `session/prompt` carrying a PNG image block (a solid red square) was
    // answered "Red" (claude-haiku-4.5, 2026-11-18).
    multimodal: true,
    // ACP session load (0.0.410+) backs the `native-resume` continuation.
    resumable: true,
    bidirectional: true,
    hooks: copilotCliNativeHooks,
  },
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Copilot model id for this session (e.g. `mai-code-2`, `claude-sonnet-5.5`, " +
        "`auto`). Applied via the ACP `model` session config option; the CLI " +
        "validates the id against your plan/entitlements and rejects an unknown one.",
    },
    {
      id: "effort",
      type: "enum",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description:
        "Reasoning effort for this session. Applied via the ACP session config " +
        "option the server advertises for it — `reasoning_effort` on Copilot (the ACP client " +
        "resolves the id from the session's configOptions); the server also accepts " +
        "`--effort`/`--reasoning-effort` at start.",
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
      checked: "2026-11-18",
      result:
        "GitHub Copilot CLI ships a first-party ACP server: `copilot --acp --stdio` " +
        "(NDJSON JSON-RPC 2.0 over stdio; TCP via `--acp --port`). Added in 0.0.397 " +
        "(2026-01-28); verified on 1.0.113 (protocolVersion 1). The server exposes `model`, " +
        "`reasoning_effort` and `mode` (agent/plan/autopilot) ACP session config options, " +
        "supports loading existing sessions (0.0.410+), accepts image prompts, and " +
        "advertises no steering: two concurrent prompts cancel each other. " +
        "This harness drives ACP, not the print/headless surface.",
    },
    print: {
      checked: "2026-11-18",
      result:
        "Not re-tested on 1.0.113 (docs only). A headless one-shot surface also exists: `copilot -p \"<prompt>\" " +
        "--output-format json` emits JSONL, with `--model`, `--resume[=ID]`, " +
        "`--allow-all-tools`, `--stream`, and `--share-gist`. Not wired here — " +
        "ACP is the richer posture and avoids a bespoke print event mapper.",
    },
    auth: {
      checked: "2026-11-18",
      result:
        "Verified on 1.0.113 (CLI keychain login / gh session). Token env precedence: COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN. " +
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
