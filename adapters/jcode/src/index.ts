/**
 * @agentproto/adapter-jcode — AIP-45 adapter for 1jehuang/jcode.
 *
 * jcode is a RAM-efficient Rust coding agent with multi-provider support
 * (Claude, OpenAI, Gemini, OpenRouter, Copilot, DeepSeek, Groq, Mistral,
 * Ollama, and OpenAI-compatible endpoints). No ACP mode is documented, so
 * this is a `protocol: "print"` (headless) arm: we spawn `jcode run
 * --ndjson "<prompt>"` per turn and map its NDJSON stream (see the
 * `jcode-ndjson` mapper in the driver's print-arm).
 *
 * Argv order matters: `run` is a clap SUBCOMMAND, so it lives in
 * `bin_args` (the spawn base) — every composed flag (`--ndjson`,
 * `--model`, `--resume`) must come AFTER it or jcode rejects the argv
 * (`error: unexpected argument '--json' found`). The prompt is
 * positional, not a flag.
 *
 *   import { jcode, jcodeRuntime } from "@agentproto/adapter-jcode"
 *   const session = await jcodeRuntime().start({
 *     env: { ANTHROPIC_API_KEY: "sk-..." },
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
import { listModels } from "@agentproto/model-catalog"
import {
  deriveDeclaredCapabilities,
  type CapabilityStrategy,
  type ProviderCapability,
} from "@agentproto/provider-kit"

/**
 * Build jcode's model menu from the shared provider catalog. jcode accepts
 * bare model ids via `--model`; the provider is inferred from the id or
 * specified explicitly via `--provider`.
 */
function buildJcodeModelMenu(): Array<{ id: string; provider: string }> {
  const supported = [
    { provider: "anthropic", prefix: "anthropic" },
    { provider: "openai", prefix: "openai" },
    { provider: "openrouter", prefix: "openrouter" },
    { provider: "google", prefix: "google" },
    { provider: "deepseek", prefix: "deepseek" },
    { provider: "groq", prefix: "groq" },
    { provider: "mistral", prefix: "mistral" },
  ] as const

  const seen = new Set<string>()
  const out: Array<{ id: string; provider: string }> = []

  for (const { provider, prefix } of supported) {
    for (const model of listModels({ kind: "llm", provider })) {
      const bareId = model.id
      const canonicalId = bareId.includes("/") ? bareId : `${prefix}/${bareId}`
      const id =
        provider === "openrouter" ? `openrouter/${bareId}` : canonicalId
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

export const jcode: AgentCliHandle = defineAgentCli({
  name: "jcode",
  id: "jcode",
  description:
    "1jehuang/jcode — RAM-efficient Rust coding agent with semantic memory, " +
    "multi-agent swarm, and broad provider support (Claude, OpenAI, Gemini, " +
    "OpenRouter, Copilot, DeepSeek, Groq, Mistral, Ollama). Spawned via " +
    "`jcode run --ndjson` in headless mode. No ACP; print/headless arm.",
  version: "0.1.0",
  bin: "jcode",
  // `run` is a clap subcommand — it must precede every composed flag, so it
  // lives in the spawn base rather than as a print `prompt_flag` (which
  // would land AFTER `--ndjson`/`--model` and be rejected by jcode).
  bin_args: ["run"],
  install: [
    { method: "brew", package: "1jehuang/jcode/jcode" },
    { method: "curl", url: "https://jcode.sh/install" },
    { method: "cargo", package: "jcode" },
  ],
  version_check: {
    cmd: "jcode --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.1.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: {
      env: [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_API_KEY",
        "DEEPSEEK_API_KEY",
        "GROQ_API_KEY",
        "MISTRAL_API_KEY",
      ],
    },
  },
  modelDerivedApiKey: true,
  sandbox: "./SANDBOX.md",
  protocol: "print",
  print: {
    // No prompt_flag: the message is positional after `run` (in bin_args).
    output_format: ["--ndjson"],
    pre_prompt: [],
    resume: { flag: "--resume", kind: "value" },
    event_schema: "jcode-ndjson",
  },
  session: {
    mode: "ephemeral",
    idle_timeout_ms: 1_800_000,
    context_carryover: false,
  },
  routeSelection: "derived-from-model",
  models: {
    default: "anthropic/claude-sonnet-4-5",
    allowed: buildJcodeModelMenu(),
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      google: "GOOGLE_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      groq: "GROQ_API_KEY",
      mistral: "MISTRAL_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: true,
    file_io: true,
    multimodal: false,
    resumable: true,
    bidirectional: false,
  },
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Model id for this run (e.g. `claude-sonnet-4-5`). Forwarded to `--model`.",
      bin_args_template: ["--model", "{value}"],
    },
    {
      id: "provider",
      type: "string",
      description:
        "Provider override (e.g. `claude`, `openai`, `gemini`). Forwarded to `--provider`.",
      bin_args_template: ["--provider", "{value}"],
    },
    {
      id: "provider_profile",
      type: "string",
      description:
        "Named provider profile for multi-account setups. Forwarded to `--provider-profile`.",
      bin_args_template: ["--provider-profile", "{value}"],
    },
  ],
  continuation: {
    default: "none",
    supported: ["none", "transcript", "native-resume"],
  },
  metadata: {
    acp: {
      checked: "2026-08-11",
      result:
        "jcode has no documented ACP mode. The CLI exposes `jcode serve` " +
        "(background server) and `jcode connect` (client attach), but neither " +
        "speaks ACP over stdio. Adapter stays print/headless until ACP ships.",
    },
    swarm: {
      checked: "2026-08-11",
      result:
        "jcode supports multi-agent swarm coordination: automatic conflict " +
        "detection, inter-agent messaging (DM + broadcast), and repo-scoped " +
        "collaboration. Not yet wired into the adapter.",
    },
  },
  tags: ["jcode", "rust", "print", "agent-runtime", "coding", "multi-provider"],
})

export function jcodeRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(jcode)
}

function apiModeForProvider(id: string): ProviderCapability["apiMode"] {
  if (id === "anthropic") return "anthropic"
  if (
    id === "openai" ||
    id === "openrouter" ||
    id === "deepseek" ||
    id === "groq" ||
    id === "mistral"
  )
    return "chat_completions"
  return undefined
}

export const jcodeCapabilities: CapabilityStrategy = async (def, ctx) => {
  const base = deriveDeclaredCapabilities(def)
  const providers: ProviderCapability[] = base.providers.map((p) => ({
    ...p,
    apiMode: apiModeForProvider(p.id),
    cred: {
      ...p.cred,
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
