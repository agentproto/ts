/**
 * WP1 — AIP-42 `model:` ref -> a model Mastra's `Agent` can run.
 *
 * Mastra 1.x ships a model router (`models.dev` gateway) that accepts a bare
 * `provider/model` string (e.g. `anthropic/claude-opus-4-8`,
 * `openrouter/z-ai/glm-5.2`) and resolves it to a live ai-sdk model, reading
 * the provider's key from the environment. So the resolver is a thin,
 * *validated* pass-through: extract the ref string, sanity-check the shape,
 * surface a friendly error when the obvious provider key is missing, and hand
 * the string to Mastra. No bespoke provider wiring, no extra ai-sdk deps.
 */

import type { ModelRef } from "@agentproto/agent"

/** Best-effort provider -> env var map, used only for a friendly preflight
 *  error. Mastra's gateway is the source of truth; this list just turns the
 *  common "forgot the key" case into a clear message instead of a deep ai-sdk
 *  stack trace. Providers not listed here skip the preflight check. */
const PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
}

/** Pull the model id string out of an AIP-42 `ModelRef` (string | { ref }). */
export function modelRefToString(ref: ModelRef): string {
  if (typeof ref === "string") return ref.trim()
  if (ref && typeof ref === "object" && typeof ref.ref === "string") {
    return ref.ref.trim()
  }
  throw new Error(
    "mastra-agent: AGENT.md `model` must be a `provider/model` string " +
      "(or { ref }); inline model objects are not supported by this adapter.",
  )
}

/** The provider segment is everything before the first `/`. */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/")
  return slash > 0 ? modelId.slice(0, slash) : modelId
}

/**
 * Infer the provider for a bare, unambiguous id so an AGENT.md stays
 * adapter-agnostic. `claude-sonnet-5` — what the claude-code / claude-sdk
 * adapters already accept bare — routes here as `anthropic/claude-sonnet-5`,
 * instead of being handed to Mastra's gateway with no provider (which fails
 * with "could not resolve model configuration"). Only Claude ids are
 * unambiguous today; every other provider still needs the explicit prefix.
 */
export function normalizeModelId(modelId: string): string {
  if (modelId.includes("/")) return modelId
  if (/^claude[-.]/i.test(modelId)) return `anthropic/${modelId}`
  return modelId
}

/**
 * Resolve an AIP-42 model ref to the value Mastra's `Agent` constructor takes.
 * Returns the `provider/model` string — Mastra routes it. `env` defaults to
 * `process.env`; injectable for tests.
 */
export function resolveMastraModel(
  ref: ModelRef,
  env: Record<string, string | undefined> = process.env,
): string {
  const modelId = normalizeModelId(modelRefToString(ref))
  if (!modelId) {
    throw new Error("mastra-agent: empty `model` ref.")
  }
  const provider = providerOf(modelId)
  const envKey = PROVIDER_ENV[provider]
  if (envKey && !env[envKey]) {
    throw new Error(
      `mastra-agent: model '${modelId}' needs ${envKey} in the environment ` +
        `(provider '${provider}'). Set it on the spawn env or export it.`,
    )
  }
  return modelId
}
