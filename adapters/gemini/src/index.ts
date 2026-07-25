/**
 * @agentproto/adapter-gemini — AIP-45 adapter for Google's Gemini CLI in ACP
 * mode (`gemini --experimental-acp`).
 *
 * The Gemini CLI is an open-source terminal agent that speaks the Agent Client
 * Protocol when launched with `--experimental-acp` (aliased to `--acp` on
 * current builds; the experimental spelling still works and matches the wider
 * ACP catalog). Install it with `npm i -g @google/gemini-cli`, then:
 *
 *   import { gemini, geminiRuntime } from "@agentproto/adapter-gemini"
 *   const session = await geminiRuntime().start({
 *     env: { GEMINI_API_KEY: "..." },
 *   })
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 *
 * The headline feature over the generic `gemini-cli` ACP catalog entry is
 * billing-auth: a native `provider` + a FILE-BASED (external) subscription so
 * "use my existing Gemini login" is a verified, observable, money-safe opt-in.
 */

import { join } from "node:path"
import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"
import type { AuthStore, CapabilityStrategy, CredSource } from "@agentproto/provider-kit"

export const gemini: AgentCliHandle = defineAgentCli({
  name: "gemini",
  id: "gemini",
  description:
    "Google's Gemini CLI in ACP mode (`gemini --experimental-acp`) — an open-source terminal agent driving Gemini models over the Agent Client Protocol via stdio JSON-RPC. Native adapter (over the generic `gemini-cli` catalog entry) so subscription billing-auth — \"use my existing Gemini login\" — is a verified, money-safe opt-in.",
  version: "0.1.0",
  bin: "gemini",
  // `--experimental-acp` starts ACP mode. Current Gemini CLI (0.45.x) prefers
  // the shorter `--acp`, but keeps `--experimental-acp` as a working alias, and
  // it's the spelling the rest of the ACP catalog uses — so keep it for parity.
  bin_args: ["--experimental-acp"],
  install: [
    {
      method: "npm",
      package: "@google/gemini-cli",
      global: true,
    },
  ],
  version_check: {
    cmd: "gemini --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.1.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    // Every api-key rail the Gemini CLI honors — all three are scrubbed under a
    // file-based subscription so a stray key can't flip billing (see below).
    state: {
      env: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    },
  },
  // Billing-auth (opt-in — no authEnforce, so unconfigured spawns stay
  // ambient). Single-provider adapter: api-key mode SETS providerEnvVar
  // ("google") = GOOGLE_GENERATIVE_AI_API_KEY, derived from the catalog.
  provider: "google",
  // "Use my existing Gemini login" — a FILE-BASED (external) subscription. The
  // Gemini CLI's OAuth login lives in `~/.gemini/oauth_creds.json`
  // (`access_token`), which the CLI reads ITSELF; it has no env-bearer channel
  // like claude-code's CLAUDE_CODE_OAUTH_TOKEN. So `external: true`: subscription
  // mode injects NOTHING (no setEnv) — the host verifies the login is present
  // (fail-loud, via the `gemini` provision recipe) and the driver only SCRUBS
  // the api-key vars so a leftover key can't silently flip the spawn to per-token
  // API billing under a "subscription" label.
  //
  // GOOGLE_GENERATIVE_AI_API_KEY is scrubbed automatically (it's the provider's
  // api-key var). GEMINI_API_KEY and GOOGLE_API_KEY are the two SIBLING keys the
  // Gemini CLI also honors — and, critically, an env API key OVERRIDES the OAuth
  // login in Google's auth precedence, so BOTH must be scrubbed for the login to
  // win (they're listed as conflictEnv). Money-safe by construction: no OAuth
  // bearer is ever written into an api-key env var, because no bearer is injected
  // at all. An unconfigured gemini spawn stays ambient — the CLI uses its own
  // oauth_creds.json precedence — so this only ADDS an explicit, verified,
  // billing-guaranteed, observable opt-in on top of that.
  authSubscription: {
    external: true,
    conflictEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./gemini-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  models: {
    default: "gemini-2.5-pro",
    // Sourced from the model catalog's curated Google (vendor "google") text
    // models — NOT hand-invented ids (see packages/model-catalog/src/llm/
    // catalog.ts). Kept to the stable + current preview lines the CLI serves.
    allowed: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite",
    ],
    env: {
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
      gemini: "GEMINI_API_KEY",
    },
    // The Gemini CLI takes its model as the documented global `-m/--model`
    // flag, composed into argv at spawn time (confirmed present on 0.45.2 via
    // `gemini --help`). It's a global flag, so it applies alongside
    // `--experimental-acp`; worst case a future ACP build ignores it and the
    // session falls back to the CLI's default model — never a mis-bill.
    apply: "arg",
    bin_args_template: ["-m", "{model}"],
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: false,
    file_io: true,
    // Gemini models are natively multimodal; the CLI forwards ACP image content
    // blocks into the Gemini vision pipeline.
    multimodal: true,
    // The Gemini CLI implements ACP session lifecycle (newSession / loadSession).
    resumable: true,
    bidirectional: true,
  },
  options: [
    {
      id: "model",
      type: "enum",
      enum: [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite",
      ],
      description: "Override the default model for this operator binding.",
      // Real composition happens via `models.apply: "arg"` above; this option
      // exists so `config.options.model` validates.
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
  tags: ["gemini", "google", "acp", "agent-runtime", "coding"],
})

export function geminiRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(gemini)
}

interface GeminiSettingsFile {
  security?: { auth?: { selectedType?: unknown } }
}

/**
 * Best-effort capability discovery for gemini: parses the Gemini CLI's own
 * `~/.gemini/settings.json` (`security.auth.selectedType`) plus the
 * presence of `~/.gemini/oauth_creds.json` to report whether the "use my
 * existing Gemini login" file-based subscription is actually live on this
 * host, alongside the api-key fallback path. Never throws — a malformed
 * settings.json just leaves `selectedType` undetermined rather than
 * blanking the whole result.
 */
export const geminiCapabilities: CapabilityStrategy = async (def, ctx) => {
  const settingsPath = join(ctx.homeDir, ".gemini", "settings.json")
  const oauthPath = join(ctx.homeDir, ".gemini", "oauth_creds.json")

  let selectedType: string | undefined
  const settingsRaw = await ctx.readFile(settingsPath)
  if (settingsRaw !== null) {
    try {
      const parsed = JSON.parse(settingsRaw) as GeminiSettingsFile
      if (typeof parsed.security?.auth?.selectedType === "string") {
        selectedType = parsed.security.auth.selectedType
      }
    } catch (err) {
      ctx.warn(
        `gemini capability discovery: could not parse ~/.gemini/settings.json: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const oauthLoginPresent = (await ctx.readFile(oauthPath)) !== null
  const oauthSelected = selectedType !== undefined && selectedType.toLowerCase().includes("oauth")

  // Same var the manifest itself declares for google (models.env.google) —
  // never a hardcoded/guessed name.
  const apiKeyEnvVar = def.models?.env?.google ?? "GOOGLE_GENERATIVE_AI_API_KEY"
  const apiKeyPresent = !!ctx.env[apiKeyEnvVar]

  const oauthPresent = oauthSelected && oauthLoginPresent
  const source: CredSource = oauthPresent
    ? { kind: "oauth-file", path: "~/.gemini/oauth_creds.json" }
    : { kind: "env", var: apiKeyEnvVar }

  const authStores: AuthStore[] = [
    { kind: "oauth-file", path: "~/.gemini/oauth_creds.json", format: "json", providerKeyed: false },
    { kind: "env", providerKeyed: false },
  ]

  const modelApply = def.models?.apply
  return {
    adapter: def.id,
    source: "discovered",
    discoverable: "parse",
    authStores,
    providers: [
      {
        id: "google",
        billingEndpoint: "google",
        cred: { present: oauthPresent || apiKeyPresent, source },
      },
    ],
    models: { mechanism: "catalog" },
    endpointCompat: {},
    application: {
      modelApply: modelApply === "command" || modelApply === "arg" ? modelApply : "config",
      postureApply: "none",
      coupled: false,
    },
  }
}

export type { AgentCliHandle, AgentCliRuntime }
