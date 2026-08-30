import { z } from "zod"

import { defineGenerator, type CatalogSource, type GeneratedFiles, type GeneratorContext } from "../types.js"

/**
 * Context window (max input tokens) + max output tokens, live per model id,
 * for the providers that publish a machine-readable models-list with this
 * data: Anthropic, Groq, xAI, Moonshot, Mistral. This is NOT pricing —
 * Anthropic's `/v1/models` carries no price at all, and Groq/xAI/Mistral
 * pricing units need separate verification before they're trusted for
 * billing; see `LLM_PRICING_CATALOG` / `OPENROUTER_ROUTES` in `catalog.ts`
 * for that.
 *
 * ZAI/Zhipu and OpenAI are deliberately excluded: ZAI's `/v4/models` list
 * returns bare `{id, owned_by, created}` with no context field, and OpenAI
 * has no stable models-list endpoint at all (see `sources/openai.ts`) — both
 * stay hand-maintained until (if ever) they publish one.
 *
 * Google/Gemini — SOURCED FROM OPENROUTER (Google API blocked), ids
 * remapped. The native source, `GET generativelanguage.googleapis.com/
 * v1beta/models` (auth via `x-goog-api-key`), would fit this generator's
 * shape directly, but every Google key available to this sync run 403s with
 * `PERMISSION_DENIED — Lightning dunning decision is deny` (a billing hold
 * on the project, not a missing/invalid key; verified 2026-08-30). Rather
 * than leave Google unsynced, we read `GET openrouter.ai/api/v1/models`
 * (already pinned as the `llm-openrouter` source for the `llm:openrouter`
 * generator — reused here, not re-fetched) and remap its `google/<id>`
 * routes to bare native ids by stripping the `google/` prefix. ONLY ids
 * that exactly match a real native Gemini id already in use elsewhere in
 * this codebase (the `gemini` adapter's `models.allowed` list,
 * `adapters/gemini/src/index.ts`, and the hand-maintained pricing rows in
 * `model-catalog/src/llm/catalog.ts`) are kept — everything else under
 * `google/` on OpenRouter is logged and skipped rather than guessed:
 * `:batch` suffixed routes (a distinct billing surface, not the same model),
 * dated/preview/image/customtools variants with no confirmed native
 * counterpart (e.g. `gemini-3-pro-image`, `gemini-2.5-pro-preview-05-06`,
 * `gemini-3.1-pro-preview-customtools`), non-Gemini families (`gemma-*`,
 * `lyria-*`), and newer Gemini lines OpenRouter carries that aren't yet a
 * confirmed native id here (`gemini-3.6-flash`, `gemini-3.7-flash`).
 * Native-only surfaces (imagen-*, gemini-live*, embedding models) never
 * appear under OpenRouter's `google/` prefix at all, so there is nothing to
 * filter for those — they simply aren't representable via this source.
 * When a working Google key exists, swap this block for a direct
 * `generativelanguage.googleapis.com/v1beta/models` source instead.
 */

/**
 * Native Google/Gemini model ids this generator is allowed to emit via the
 * OpenRouter remap, verified against `adapters/gemini/src/index.ts`
 * (`models.allowed`) and the hand-maintained Google rows in
 * `model-catalog/src/llm/catalog.ts` — the two places that would break if a
 * wrong id slipped in. Do not add to this list from OpenRouter data alone;
 * a new entry needs the same cross-check.
 */
const GOOGLE_NATIVE_MODEL_IDS = new Set([
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
])

/** Repo-relative drop-in target for {@link @agentproto/model-catalog}. */
const OUTPUT_PATH = "packages/model-catalog/src/llm/context-windows.generated.ts"

// ── Output shape (mirrors ContextWindowEntry in model-catalog's catalog.ts) ──

interface ContextWindowEntry {
  contextWindow: number
  maxOutput?: number
  displayName?: string
  provider: "anthropic" | "groq" | "xai" | "moonshot" | "mistral" | "google"
}

// ── Source schemas ───────────────────────────────────────────────────────
// Each provider's models-list shape, verified against the live payload
// (2026-07-16). `passthrough()` keeps unrelated fields forward-compatible.

const AnthropicModelSchema = z
  .object({
    id: z.string(),
    display_name: z.string().optional(),
    max_input_tokens: z.number().optional(),
    max_tokens: z.number().optional(),
  })
  .passthrough()
const AnthropicSnapshotSchema = z.object({ data: z.array(AnthropicModelSchema) })

const GroqModelSchema = z
  .object({
    id: z.string(),
    context_window: z.number().optional(),
    max_completion_tokens: z.number().optional(),
  })
  .passthrough()
const GroqSnapshotSchema = z.object({ data: z.array(GroqModelSchema) })

// xAI's `context_length` is `null` for non-text models (e.g. grok-imagine-video).
const XaiModelSchema = z
  .object({
    id: z.string(),
    context_length: z.number().nullable().optional(),
  })
  .passthrough()
const XaiSnapshotSchema = z.object({ data: z.array(XaiModelSchema) })

const MoonshotModelSchema = z
  .object({
    id: z.string(),
    context_length: z.number().optional(),
  })
  .passthrough()
const MoonshotSnapshotSchema = z.object({ data: z.array(MoonshotModelSchema) })

// Mistral's `name` is NOT a human display name — it's an alias pointing at
// the canonical dated id (e.g. id `mistral-small-latest`, name
// `mistral-small-2603`), so it's read only as passthrough, never surfaced as
// `displayName` (verified against the live payload, 2026-08-30).
const MistralModelSchema = z
  .object({
    id: z.string(),
    max_context_length: z.number().optional(),
  })
  .passthrough()
const MistralSnapshotSchema = z.object({ data: z.array(MistralModelSchema) })

// OpenRouter's `/api/v1/models` — reused (same source id, same pinned
// snapshot) from `llm-openrouter.ts`'s own generator. We only read
// `context_length` and `top_provider.max_completion_tokens`; pricing is
// deliberately NOT read here (see the module doc comment / generator below).
const OpenRouterModelSchema = z
  .object({
    id: z.string(),
    context_length: z.number().nullable().optional(),
    top_provider: z
      .object({ max_completion_tokens: z.number().nullable().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()
const OpenRouterSnapshotSchema = z.object({ data: z.array(OpenRouterModelSchema) })

// ── Serialization ────────────────────────────────────────────────────────

function serializeEntry(e: ContextWindowEntry): string {
  const fields: string[] = [`contextWindow: ${e.contextWindow}`]
  if (e.maxOutput !== undefined) fields.push(`maxOutput: ${e.maxOutput}`)
  if (e.displayName !== undefined) fields.push(`displayName: ${JSON.stringify(e.displayName)}`)
  fields.push(`provider: ${JSON.stringify(e.provider)}`)
  return `{ ${fields.join(", ")} }`
}

function serializeFile(entries: Record<string, ContextWindowEntry>): string {
  const ids = Object.keys(entries).sort()
  const lines: string[] = [
    "// AUTO-GENERATED by @agentproto/catalog-sync (llm:context-windows).",
    "// Do not edit by hand — re-run `pnpm --filter @agentproto/catalog-sync generate --refresh`.",
    "// Sources: api.anthropic.com/v1/models, api.groq.com/openai/v1/models,",
    "//         api.x.ai/v1/models, api.moonshot.ai/v1/models,",
    "//         api.mistral.ai/v1/models",
    "// google entries: SOURCED FROM OPENROUTER (openrouter.ai/api/v1/models),",
    "//         Google's native API is billing-blocked — ids remapped from",
    "//         google/<id> to the bare native id; see the generator's module",
    "//         doc comment for the exact remap + skip rules.",
    "// Context window (max input tokens) + max output tokens per live model id.",
    "// NOT pricing — see LLM_PRICING_CATALOG / OPENROUTER_ROUTES in catalog.ts.",
    "",
    "export interface ContextWindowEntry {",
    "  contextWindow: number",
    "  maxOutput?: number",
    "  displayName?: string",
    '  provider: "anthropic" | "groq" | "xai" | "moonshot" | "mistral" | "google"',
    "}",
    "",
    "export const CONTEXT_WINDOWS: Record<string, ContextWindowEntry> = {",
  ]
  for (const id of ids) {
    lines.push(`  ${JSON.stringify(id)}: ${serializeEntry(entries[id]!)},`)
  }
  lines.push("}")
  lines.push("")
  return lines.join("\n")
}

// ── Generator ───────────────────────────────────────────────────────────

async function generate(ctx: GeneratorContext): Promise<GeneratedFiles> {
  const entries: Record<string, ContextWindowEntry> = {}

  const anthropicSrc = sources.find(s => s.id === "llm-anthropic")
  if (anthropicSrc) {
    const parsed = AnthropicSnapshotSchema.parse(await ctx.fetchSource(anthropicSrc))
    for (const m of parsed.data) {
      if (!m.max_input_tokens || !m.max_tokens) continue
      entries[m.id] = {
        contextWindow: m.max_input_tokens,
        maxOutput: m.max_tokens,
        ...(m.display_name ? { displayName: m.display_name } : {}),
        provider: "anthropic",
      }
    }
  }

  const groqSrc = sources.find(s => s.id === "llm-groq")
  if (groqSrc) {
    const parsed = GroqSnapshotSchema.parse(await ctx.fetchSource(groqSrc))
    for (const m of parsed.data) {
      if (!m.context_window) continue
      entries[m.id] = {
        contextWindow: m.context_window,
        ...(m.max_completion_tokens ? { maxOutput: m.max_completion_tokens } : {}),
        provider: "groq",
      }
    }
  }

  const xaiSrc = sources.find(s => s.id === "llm-xai")
  if (xaiSrc) {
    const parsed = XaiSnapshotSchema.parse(await ctx.fetchSource(xaiSrc))
    for (const m of parsed.data) {
      if (!m.context_length) continue
      entries[m.id] = { contextWindow: m.context_length, provider: "xai" }
    }
  }

  const moonshotSrc = sources.find(s => s.id === "llm-moonshot")
  if (moonshotSrc) {
    const parsed = MoonshotSnapshotSchema.parse(await ctx.fetchSource(moonshotSrc))
    for (const m of parsed.data) {
      if (!m.context_length) continue
      entries[m.id] = { contextWindow: m.context_length, provider: "moonshot" }
    }
  }

  const mistralSrc = sources.find(s => s.id === "llm-mistral")
  if (mistralSrc) {
    const parsed = MistralSnapshotSchema.parse(await ctx.fetchSource(mistralSrc))
    for (const m of parsed.data) {
      if (!m.max_context_length) continue
      entries[m.id] = { contextWindow: m.max_context_length, provider: "mistral" }
    }
  }

  // Google/Gemini via OpenRouter (see module doc comment for the "why").
  const googleSrc = sources.find(s => s.id === "llm-openrouter")
  if (googleSrc) {
    const parsed = OpenRouterSnapshotSchema.parse(await ctx.fetchSource(googleSrc))
    for (const m of parsed.data) {
      if (!m.id.startsWith("google/")) continue
      const nativeId = m.id.slice("google/".length)
      if (m.id.includes(":")) {
        console.error(
          `llm:context-windows: skipping "${m.id}" — ":"-suffixed batch route, ` +
            `not the same billing surface as the base model.`
        )
        continue
      }
      if (!GOOGLE_NATIVE_MODEL_IDS.has(nativeId)) {
        console.error(
          `llm:context-windows: skipping "${m.id}" — no confirmed native Gemini ` +
            `id "${nativeId}" (see GOOGLE_NATIVE_MODEL_IDS); not guessing the remap.`
        )
        continue
      }
      if (!m.context_length) continue
      entries[nativeId] = {
        contextWindow: m.context_length,
        ...(m.top_provider?.max_completion_tokens
          ? { maxOutput: m.top_provider.max_completion_tokens }
          : {}),
        provider: "google",
      }
    }
  }

  return { [OUTPUT_PATH]: serializeFile(entries) }
}

const sources: CatalogSource[] = [
  {
    id: "llm-anthropic",
    url: "https://api.anthropic.com/v1/models?limit=1000",
    headers: {
      "x-api-key": "env:ANTHROPIC_API_KEY",
      "anthropic-version": "2023-06-01",
    },
  },
  {
    id: "llm-groq",
    url: "https://api.groq.com/openai/v1/models",
    headers: { Authorization: "Bearer env:GROQ_API_KEY" },
  },
  {
    id: "llm-xai",
    url: "https://api.x.ai/v1/models",
    headers: { Authorization: "Bearer env:XAI_API_KEY" },
  },
  {
    id: "llm-moonshot",
    url: "https://api.moonshot.ai/v1/models",
    headers: { Authorization: "Bearer env:MOONSHOT_API_KEY" },
  },
  {
    id: "llm-mistral",
    url: "https://api.mistral.ai/v1/models",
    headers: { Authorization: "Bearer env:MISTRAL_API_KEY" },
  },
  // Google via OpenRouter (no Google key needed — see module doc comment).
  // Same source id/url as `llm-openrouter.ts`'s own generator, so both share
  // the one pinned `snapshots/llm-openrouter.json` instead of fetching twice.
  {
    id: "llm-openrouter",
    url: "https://openrouter.ai/api/v1/models",
  },
]

export const llmContextWindowsGenerator = defineGenerator({
  name: "llm:context-windows",
  modality: "llm",
  sources,
  generate,
})
