/**
 * @agentproto/adapter-mastracode — AIP-45 adapter for Mastra Code.
 *
 * Mastra Code does not currently expose a discoverable ACP subcommand
 * (`mastracode acp --help` prints the top-level CLI help). We spawn
 * its documented headless CLI via `npx -y mastracode` and mark this
 * adapter as a print/headless protocol arm rather than claiming ACP.
 *
 *   import { mastracode, mastracodeRuntime } from "@agentproto/adapter-mastracode"
 *   const session = await mastracodeRuntime().start()
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
import { listModels } from "@agentproto/model-catalog"
import {
  deriveDeclaredCapabilities,
  type CapabilityStrategy,
  type ProviderCapability,
} from "@agentproto/provider-kit"

/**
 * Build mastracode's model menu from the shared provider catalog. Mastra Code
 * routes by the model id's own `<provider>/<id>` prefix, so every entry
 * carries the billing provider.
 *
 * Providers: Anthropic, OpenAI, OpenRouter, Google — matching models.env.
 */
function buildMastracodeModelMenu(): Array<{ id: string; provider: string }> {
  const supported = [
    { provider: "anthropic", prefix: "anthropic" },
    { provider: "openai", prefix: "openai" },
    { provider: "openrouter", prefix: "openrouter" },
    { provider: "google", prefix: "google" },
  ] as const

  const seen = new Set<string>()
  const out: Array<{ id: string; provider: string }> = []

  for (const { provider, prefix } of supported) {
    for (const model of listModels({ kind: "llm", provider })) {
      const bareId = model.id
      const canonicalId = bareId.includes("/") ? bareId : `${prefix}/${bareId}`
      const id = provider === "openrouter" ? `openrouter/${bareId}` : canonicalId
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, provider })
    }
  }

  return out.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    return a.id.localeCompare(b.id)
  })
}

export const mastracode: AgentCliHandle = defineAgentCli({
  name: "mastracode",
  id: "mastracode",
  description:
    "Mastra Code — terminal-based AI coding agent with persistent threads, tools, modes, and multi-provider model support. Current CLI exposes TUI/headless operation, not ACP; spawned via `npx -y mastracode`.",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "mastracode"],
  install: [{ method: "npm", package: "mastracode", global: true }],
  version_check: {
    cmd: "npm view mastracode version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.26.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: {
      // The env names mastracode actually consults per provider. For Google it
      // is GOOGLE_API_KEY, not GOOGLE_GENERATIVE_AI_API_KEY: @mastra/core's
      // PROVIDER_REGISTRY.google.apiKeyEnvVar is the alias array
      // ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], but @mastra/code-sdk
      // collapses it to envVars[0] (GOOGLE_API_KEY) before the env-key check.
      env: [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_API_KEY",
      ],
    },
  },
  // Mastra Code's model router reads the provider straight off each id's own
  // `<provider>/<id>` prefix and consults the matching provider env var
  // (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, …). There is no
  // fixed provider. Declaring this lets the runtime's billing-auth
  // resolver and catalog eligibility manifest include api-key profiles for the
  // model-derived direct endpoint.
  modelDerivedApiKey: true,
  // mastracode's own Claude Pro/Max login (its TUI `/login` → Anthropic
  // OAuth via `anthropicOAuthProvider`, stored in the CLI's auth.json under
  // its app-data dir with its own refresh token). EXTERNAL: the runtime
  // injects no bearer — an agentproto-held `sk-ant-oat…` token presented on
  // mastracode's x-api-key channel is rejected upstream as an invalid key,
  // so the ONLY working subscription path is the CLI's own login.
  // Subscription mode verifies that login is present (fail-loud, via the
  // `mastracode` provision recipe) and scrubs the api-key vars so a
  // leftover ANTHROPIC_API_KEY can't override it. Scoped
  // `provider: "anthropic"`: never lights up its openai/openrouter models.
  authSubscription: {
    external: true,
    provider: "anthropic",
  },
  sandbox: "./SANDBOX.md",
  protocol: "print",
  print: {
    prompt_flag: "--prompt",
    output_format: ["--output", "jsonl"],
    pre_prompt: [],
    resume: { flag: "--thread", kind: "value" },
    event_schema: "mastra-jsonl",
  },
  session: {
    mode: "ephemeral",
    idle_timeout_ms: 1_800_000,
    context_carryover: false,
  },
  // Mastra's model router reads the provider straight off each id's own
  // `<provider>/<id>` prefix (no adapter mode), so the route falls out of the
  // chosen model — there is nothing independent to select → derived-from-model.
  routeSelection: "derived-from-model",
  models: {
    default: "anthropic/claude-sonnet-4-5",
    // Generated from the shared provider catalog so the Configuration Lab /
    // harness picker shows genuinely reachable Anthropic / OpenAI / OpenRouter
    // / Google models. The free-form `model` option still accepts any id.
    allowed: buildMastracodeModelMenu(),
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      // mastracode reads GOOGLE_API_KEY for `google` (see the auth.state.env
      // note above) — NOT GOOGLE_GENERATIVE_AI_API_KEY.
      google: "GOOGLE_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: true,
    file_io: true,
    multimodal: false,
    // `mastracode --thread <id>` reattaches to a prior thread with real
    // persisted memory (confirmed cross-process: separate spawn, same
    // thread id, correct continuity). `print.resume` below drives this.
    resumable: true,
    bidirectional: false,
  },
  modes: [
    {
      id: "default",
      description:
        "Default headless mode. Mastra Code defaults to build mode when omitted.",
    },
    {
      id: "plan",
      description:
        "Plan-only mode — analyze architecture and propose implementation plans before writing code.",
      bin_args_append: ["--mode", "plan"],
    },
    {
      id: "build",
      description:
        "Build mode — file edits and shell commands use Mastra Code's configured permissions.",
      bin_args_append: ["--mode", "build"],
    },
    {
      id: "fast",
      description: "Fast mode — lower-latency answers and small edits.",
      bin_args_append: ["--mode", "fast"],
    },
  ],
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Provider/model override for this operator binding (e.g. `anthropic/claude-sonnet-4-5`).",
      bin_args_template: ["--model", "{value}"],
    },
    {
      id: "thinking_level",
      type: "enum",
      enum: ["off", "low", "medium", "high", "xhigh"],
      description: "Thinking level passed to Mastra Code.",
      bin_args_template: ["--thinking-level", "{value}"],
    },
    {
      id: "timeout",
      type: "integer",
      min: 1,
      max: 86_400,
      description: "Maximum headless run duration in seconds.",
      bin_args_template: ["--timeout", "{value}"],
    },
  ],
  continuation: {
    default: "none",
    supported: ["none", "transcript", "native-resume"],
  },
  metadata: {
    acp: {
      checked: "2026-06-30",
      result:
        "`mastracode acp --help` prints top-level Mastra Code help; no ACP subcommand is currently discoverable.",
    },
    lean: {
      checked: "2026-07-03",
      result:
        "No `lean` mode declared. The headless entrypoint this adapter spawns " +
        "(runMCCli, driven by `--prompt`) has no flag to drop skill/subagent/OM " +
        "scaffolding, and does not read the MASTRACODE_DISABLE_MCP / " +
        "MASTRACODE_DISABLE_HOOKS / MASTRACODE_DISABLE_MEMORY env vars — those " +
        "are wired only into the interactive TUI entrypoint (tuiMain), so declaring " +
        "them here would silently do nothing. `--settings <path>` could point at a " +
        "leaner packaged settings.json, but that means shipping and maintaining an " +
        "actual settings file, not just a manifest patch — revisit if worth doing.",
    },
  },
  tags: ["mastracode", "mastra", "print", "agent-runtime", "coding"],
})

export function mastracodeRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(mastracode)
}

/**
 * Mastra Code reads provider API keys straight from the ambient env per
 * `models.env` (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, …).
 * There is no native creds/model-listing store to discover, so this stays on
 * the manifest-derived env-slot projection for `providers`/`models`/
 * `authStores`. It does enhance the provider list with the wire protocol each
 * direct route speaks, and it is honest that every route is api-key only —
 * Mastra Code has no Anthropic subscription bearer path.
 */
function apiModeForProvider(id: string): ProviderCapability["apiMode"] {
  if (id === "anthropic") return "anthropic"
  if (id === "openai" || id === "openrouter") return "chat_completions"
  return undefined
}

export const mastracodeCapabilities: CapabilityStrategy = async (def, ctx) => {
  const base = deriveDeclaredCapabilities(def)
  const providers: ProviderCapability[] = base.providers.map((p) => ({
    ...p,
    apiMode: apiModeForProvider(p.id),
    cred: {
      ...p.cred,
      // The manifest already names the env var; reflect whether it is present
      // on this host without ever surfacing the value.
      present: !!ctx.env[p.cred.source.kind === "env" ? p.cred.source.var : ""],
    },
  }))
  return {
    ...base,
    source: "discovered",
    discoverable: "live",
    providers,
    application: { modelApply: "arg", postureApply: "arg", coupled: false },
  }
}

export type { AgentCliHandle, AgentCliRuntime }
