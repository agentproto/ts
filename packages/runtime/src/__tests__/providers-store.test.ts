import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  injectProviderKeysIntoEnv,
  loadProviders,
  providerEnvVar,
  providersPath,
  removeProviderKey,
  setProviderKey,
} from "../providers-store.js"

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
})
