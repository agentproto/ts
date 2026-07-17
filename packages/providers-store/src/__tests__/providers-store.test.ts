import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  injectProviderKeysIntoEnv,
  loadProviders,
  providerEnvAliases,
  providerEnvVar,
  providersPath,
  removeProviderKey,
  setProviderKey,
} from "../index.js"

// providersPath() resolves under os.homedir() → $HOME on POSIX, so a temp
// HOME fully isolates these tests.
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-prov-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("providers store", () => {
  it("maps known + unknown providers to env vars", () => {
    expect(providerEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY")
    expect(providerEnvVar("openrouter")).toBe("OPENROUTER_API_KEY")
    expect(providerEnvVar("vercel-ai-gateway")).toBe("AI_GATEWAY_API_KEY")
    // unknown → <NAME>_API_KEY fallback
    expect(providerEnvVar("acme-llm")).toBe("ACME_LLM_API_KEY")
  })

  it("set → load round-trips and returns the env var", async () => {
    const env = await setProviderKey("anthropic", "sk-ant-xyz")
    expect(env).toBe("ANTHROPIC_API_KEY")
    const file = await loadProviders()
    expect(file.providers.anthropic?.apiKey).toBe("sk-ant-xyz")
    expect(file.providers.anthropic?.updatedAt).toBeTruthy()
  })

  it("writes providers.json with mode 0600", async () => {
    await setProviderKey("openrouter", "sk-or-abc")
    const { mode } = await stat(providersPath())
    expect(mode & 0o777).toBe(0o600)
  })

  it("rm removes a key and reports existence", async () => {
    await setProviderKey("openai", "sk-1")
    expect(await removeProviderKey("openai")).toBe(true)
    expect(await removeProviderKey("openai")).toBe(false)
    expect((await loadProviders()).providers.openai).toBeUndefined()
  })

  it("injects stored keys into env but NEVER overwrites explicit env", async () => {
    await setProviderKey("anthropic", "sk-from-store")
    await setProviderKey("openrouter", "sk-or-from-store")
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-explicit-wins" }
    const injected = await injectProviderKeysIntoEnv(env)
    // explicit ANTHROPIC kept; openrouter injected fresh
    expect(env.ANTHROPIC_API_KEY).toBe("sk-explicit-wins")
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-from-store")
    expect(injected).toContain("openrouter")
    expect(injected).not.toContain("anthropic")
  })

  it("persists and injects a custom base URL", async () => {
    await setProviderKey("openrouter", "sk-or", "https://proxy.example/v1")
    const env: NodeJS.ProcessEnv = {}
    await injectProviderKeysIntoEnv(env)
    expect(env.OPENROUTER_API_KEY).toBe("sk-or")
    expect(env.OPENROUTER_BASE_URL).toBe("https://proxy.example/v1")
  })

  it("returns empty when no store exists", async () => {
    const file = await loadProviders()
    expect(file).toEqual({ version: 1, providers: {} })
  })

  // ── env-name aliases (one stored key → several env names) ──────────────

  it("exposes verified aliases for a provider, none for the rest", () => {
    // google is the first real case: mastracode reads GOOGLE_API_KEY, our
    // canonical name is GOOGLE_GENERATIVE_AI_API_KEY.
    expect(providerEnvVar("google")).toBe("GOOGLE_GENERATIVE_AI_API_KEY")
    expect(providerEnvAliases("google")).toEqual(["GOOGLE_API_KEY"])
    // Providers with no verified alias return an empty list.
    expect(providerEnvAliases("anthropic")).toEqual([])
    expect(providerEnvAliases("openrouter")).toEqual([])
    expect(providerEnvAliases("acme-llm")).toEqual([])
  })

  it("injects the canonical name AND every alias for one stored key", async () => {
    await setProviderKey("google", "sk-goog-from-store")
    const env: NodeJS.ProcessEnv = {}
    const injected = await injectProviderKeysIntoEnv(env)
    // Canonical + alias both carry the same key.
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("sk-goog-from-store")
    expect(env.GOOGLE_API_KEY).toBe("sk-goog-from-store")
    // The boot log names the provider once, not once per env name.
    expect(injected).toEqual(["google"])
  })

  it("does not fabricate extra env names for a provider with no alias", async () => {
    await setProviderKey("anthropic", "sk-ant-solo")
    const env: NodeJS.ProcessEnv = {}
    await injectProviderKeysIntoEnv(env)
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-solo")
    // Only the one canonical name — no phantom alias keys.
    expect(Object.keys(env)).toEqual(["ANTHROPIC_API_KEY"])
  })

  it("explicit env wins PER NAME — an explicit alias is never clobbered", async () => {
    await setProviderKey("google", "sk-goog-from-store")
    // Operator exported the alias explicitly; canonical is unset.
    const env: NodeJS.ProcessEnv = { GOOGLE_API_KEY: "sk-goog-explicit" }
    const injected = await injectProviderKeysIntoEnv(env)
    // Explicit alias preserved; canonical filled from the store.
    expect(env.GOOGLE_API_KEY).toBe("sk-goog-explicit")
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("sk-goog-from-store")
    // Something was injected (the canonical), so the provider is reported once.
    expect(injected).toEqual(["google"])
  })

  it("skips a provider whose canonical AND every alias are already set", async () => {
    await setProviderKey("google", "sk-goog-from-store")
    const env: NodeJS.ProcessEnv = {
      GOOGLE_GENERATIVE_AI_API_KEY: "sk-canonical-explicit",
      GOOGLE_API_KEY: "sk-alias-explicit",
    }
    const injected = await injectProviderKeysIntoEnv(env)
    // Nothing overwritten, provider not reported as injected.
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("sk-canonical-explicit")
    expect(env.GOOGLE_API_KEY).toBe("sk-alias-explicit")
    expect(injected).not.toContain("google")
  })
})
