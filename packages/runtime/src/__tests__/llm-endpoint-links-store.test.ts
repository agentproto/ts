import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuthProfile } from "@agentproto/auth"
import {
  CANONICAL_UPSTREAMS,
  UnknownUpstreamError,
  eligibleProfilesForUpstream,
  getLlmEndpointLink,
  injectLlmEndpointLinksIntoEnv,
  isProfileEligibleForUpstream,
  listLlmEndpointLinks,
  llmEndpointLinksPath,
  loadLlmEndpointLinks,
  removeLlmEndpointLink,
  setLlmEndpointLink,
  upstreamProfileEnvVar,
} from "../llm-endpoint-links-store.js"

// llmEndpointLinksPath() resolves under os.homedir() → $HOME on POSIX, so a
// temp HOME fully isolates these tests (same isolation the auth profile-store
// and providers-store tests use).
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-llm-links-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

function profile(over: Partial<AuthProfile>): AuthProfile {
  return {
    id: "p",
    endpoint: "anthropic",
    method: "api-key",
    ...over,
  }
}

describe("llm-endpoint links store", () => {
  it("starts empty when no file exists", async () => {
    await expect(listLlmEndpointLinks()).resolves.toEqual({})
    await expect(getLlmEndpointLink("anthropic")).resolves.toBeUndefined()
  })

  it("set → get → list round-trips a link", async () => {
    await setLlmEndpointLink("anthropic", "claude-subs")
    await setLlmEndpointLink("openrouter", "or-key")
    await expect(getLlmEndpointLink("anthropic")).resolves.toBe("claude-subs")
    await expect(listLlmEndpointLinks()).resolves.toEqual({
      anthropic: "claude-subs",
      openrouter: "or-key",
    })
  })

  it("set replaces an existing link", async () => {
    await setLlmEndpointLink("anthropic", "a")
    await setLlmEndpointLink("anthropic", "b")
    await expect(getLlmEndpointLink("anthropic")).resolves.toBe("b")
  })

  it("persists a version-1 envelope on disk, mode 0600", async () => {
    await setLlmEndpointLink("zai", "zprofile")
    const raw = await readFile(llmEndpointLinksPath(), "utf8")
    expect(JSON.parse(raw)).toEqual({ version: 1, links: { zai: "zprofile" } })
    const mode = (await stat(llmEndpointLinksPath())).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("remove returns true when a link existed, false otherwise", async () => {
    await setLlmEndpointLink("anthropic", "x")
    await expect(removeLlmEndpointLink("anthropic")).resolves.toBe(true)
    await expect(getLlmEndpointLink("anthropic")).resolves.toBeUndefined()
    await expect(removeLlmEndpointLink("anthropic")).resolves.toBe(false)
  })

  it("rejects an unknown upstream on set and remove", async () => {
    await expect(setLlmEndpointLink("not-a-provider", "x")).rejects.toBeInstanceOf(
      UnknownUpstreamError,
    )
    await expect(removeLlmEndpointLink("gemini", )).rejects.toBeInstanceOf(
      UnknownUpstreamError,
    )
    // Nothing was written.
    await expect(listLlmEndpointLinks()).resolves.toEqual({})
  })

  it("all 8 canonical upstreams are accepted", async () => {
    for (const provider of CANONICAL_UPSTREAMS) {
      await setLlmEndpointLink(provider, `${provider}-profile`)
    }
    const links = await listLlmEndpointLinks()
    expect(Object.keys(links).sort()).toEqual([...CANONICAL_UPSTREAMS].sort())
  })

  it("loadLlmEndpointLinks drops junk (unknown provider / non-string) from disk", async () => {
    // Hand-write a file with a valid link, an unknown provider, and a non-string.
    await setLlmEndpointLink("anthropic", "keep")
    const { writeFile } = await import("node:fs/promises")
    await writeFile(
      llmEndpointLinksPath(),
      JSON.stringify({
        version: 1,
        links: { anthropic: "keep", bogus: "drop", openrouter: 42 },
      }),
    )
    const file = await loadLlmEndpointLinks()
    expect(file.links).toEqual({ anthropic: "keep" })
  })
})

describe("injectLlmEndpointLinksIntoEnv", () => {
  it("injects LLM_ENDPOINT_PROFILE_<P> for each stored link", async () => {
    await setLlmEndpointLink("anthropic", "claude-subs")
    await setLlmEndpointLink("moonshot", "moon")
    const env: NodeJS.ProcessEnv = {}
    const injected = await injectLlmEndpointLinksIntoEnv(env)
    expect(env.LLM_ENDPOINT_PROFILE_ANTHROPIC).toBe("claude-subs")
    expect(env.LLM_ENDPOINT_PROFILE_MOONSHOT).toBe("moon")
    expect(injected.sort()).toEqual(["anthropic", "moonshot"])
  })

  it("does not overwrite a pre-set env var (explicit wins per var)", async () => {
    await setLlmEndpointLink("anthropic", "from-store")
    const env: NodeJS.ProcessEnv = { LLM_ENDPOINT_PROFILE_ANTHROPIC: "from-env" }
    const injected = await injectLlmEndpointLinksIntoEnv(env)
    expect(env.LLM_ENDPOINT_PROFILE_ANTHROPIC).toBe("from-env")
    expect(injected).toEqual([])
  })

  it("no links → env unchanged", async () => {
    const env: NodeJS.ProcessEnv = { FOO: "bar" }
    const injected = await injectLlmEndpointLinksIntoEnv(env)
    expect(injected).toEqual([])
    expect(env).toEqual({ FOO: "bar" })
  })

  it("env-var name matches the proxy's LLM_ENDPOINT_PROFILE_<UPPER> convention", () => {
    expect(upstreamProfileEnvVar("anthropic")).toBe("LLM_ENDPOINT_PROFILE_ANTHROPIC")
    expect(upstreamProfileEnvVar("openrouter")).toBe("LLM_ENDPOINT_PROFILE_OPENROUTER")
  })
})

describe("upstream eligibility predicate", () => {
  it("an api-key profile at the matching endpoint is eligible", () => {
    expect(
      isProfileEligibleForUpstream(profile({ endpoint: "openrouter", method: "api-key" }), "openrouter"),
    ).toBe(true)
  })

  it("a wrong-endpoint profile is excluded", () => {
    expect(
      isProfileEligibleForUpstream(profile({ endpoint: "openrouter", method: "api-key" }), "moonshot"),
    ).toBe(false)
  })

  it("a disabled profile is excluded", () => {
    expect(
      isProfileEligibleForUpstream(
        profile({ endpoint: "anthropic", method: "api-key", disabled: true }),
        "anthropic",
      ),
    ).toBe(false)
  })

  it("oauth-bearer is eligible ONLY for anthropic", () => {
    expect(
      isProfileEligibleForUpstream(profile({ endpoint: "anthropic", method: "oauth-bearer" }), "anthropic"),
    ).toBe(true)
    // An oauth-bearer profile whose endpoint is a non-anthropic upstream — the
    // fail-closed rule (never forward an OAuth bearer to a third-party host).
    expect(
      isProfileEligibleForUpstream(profile({ endpoint: "openrouter", method: "oauth-bearer" }), "openrouter"),
    ).toBe(false)
  })

  it("eligibleProfilesForUpstream filters a mixed list", () => {
    const profiles: AuthProfile[] = [
      profile({ id: "a", endpoint: "anthropic", method: "oauth-bearer" }),
      profile({ id: "b", endpoint: "anthropic", method: "api-key" }),
      profile({ id: "c", endpoint: "anthropic", method: "api-key", disabled: true }),
      profile({ id: "d", endpoint: "openrouter", method: "api-key" }),
    ]
    expect(eligibleProfilesForUpstream(profiles, "anthropic").map(p => p.id)).toEqual(["a", "b"])
    expect(eligibleProfilesForUpstream(profiles, "openrouter").map(p => p.id)).toEqual(["d"])
  })
})
