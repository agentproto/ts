/**
 * Coverage for the money bug fixed in session-restart-core.ts:
 * `restartAgentSession` used to respawn with NO billing-auth resolution
 * at all, so a session pinned to `subscription` billing could silently
 * come back on ambient env (e.g. a leaked `ANTHROPIC_API_KEY`) instead —
 * an unpinned, unbilled-as-expected spawn with no signal anywhere.
 *
 * Mirrors the mock style of session-spawn.test.ts: `../providers-store.js`
 * is mocked via `vi.hoisted`/`vi.mock` so the api-key store lookup is
 * deterministic and never touches the real `~/.agentproto` files. Every
 * `startSession` stub here also re-implements the driver's own
 * fail-fast check (`@agentproto/driver-agent-cli`'s `missing_auth_credential`)
 * so a spec that engages with no credential actually throws, proving
 * restart's fail-loud contract end-to-end without depending on the
 * driver package.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const storeKeys = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }))
vi.mock("../providers-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers-store.js")>()
  return { ...actual, getProviderKey: vi.fn(async (p: string) => storeKeys.value[p]) }
})

import { restartAgentSession } from "../session-restart-core.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

type CapturedAuth = {
  mode: "subscription" | "api-key"
  credential?: string
  setEnv: string
  unsetEnv: string[]
  explicit: boolean
  enforce: "always" | "when-configured"
}

/**
 * Stub adapter resolver whose `startSession` replicates the driver's own
 * `missing_auth_credential` fail-fast (define-agent-cli.ts) — an ENGAGED
 * spec (enforce:"always" or explicit:true) with no `credential` throws,
 * exactly as the real driver would, so the "fails loud, no session" tests
 * below don't depend on the driver package to prove the point.
 */
function makeAuthResolver(
  descriptor: AdapterAuthDescriptor | undefined,
): { resolver: AgentAdapterResolver; captured: { auth?: CapturedAuth }[] } {
  const captured: { auth?: CapturedAuth }[] = []
  const resolver: AgentAdapterResolver = async () => ({
    startSession: vi.fn(async (o: { auth?: CapturedAuth }) => {
      const authSpec = o.auth
      const engaged = !!authSpec && (authSpec.enforce === "always" || authSpec.explicit === true)
      if (authSpec && engaged && !authSpec.credential) {
        throw new Error(
          `missing_auth_credential: auth mode "${authSpec.mode}" requires an explicit credential`,
        )
      }
      captured.push({ auth: authSpec })
      return fakeAgentSession()
    }),
    commandPreview: "mock-adapter",
    ...(descriptor ? { authDescriptor: descriptor } : {}),
  })
  return { resolver, captured }
}

const CODEX_DESC = { provider: "openai" as const }
const CLAUDE_CODE_DESC = {
  provider: "anthropic" as const,
  authEnforce: "always" as const,
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    unsetEnvAdd: ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BASE_URL"],
  },
}

describe("restartAgentSession — billing-auth re-resolution", () => {
  beforeEach(() => {
    storeKeys.value = {}
  })

  it("(1) prior subscription-mode echo re-resolves the subscription credential from config and re-echoes it", async () => {
    const { resolver, captured } = makeAuthResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "claude-code",
      auth: {
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: async () => ({
        adapters: { "claude-code": { auth: { token: "sk-ant-oat01-freshtoken9999" } } },
      }),
    })

    expect(captured[0]?.auth).toMatchObject({
      mode: "subscription",
      credential: "sk-ant-oat01-freshtoken9999",
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      explicit: true,
      enforce: "always",
    })
    expect(restarted.desc.auth).toMatchObject({
      mode: "subscription",
      provider: "anthropic",
      credentialSource: "explicit-config",
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      fingerprint: "subscription · sk-ant-oat…9999",
    })
  })

  it("(2) prior api-key-mode echo re-resolves the api-key credential (from providers.json) and re-echoes it", async () => {
    storeKeys.value = { openai: "sk-proj-fromstore0000" }
    const { resolver, captured } = makeAuthResolver(CODEX_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "codex",
      auth: {
        mode: "api-key",
        fingerprint: "api-key · sk-proj-…OLD1",
        provider: "openai",
        credentialSource: "providers-store",
        setEnv: "OPENAI_API_KEY",
      },
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: async () => undefined,
    })

    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      credential: "sk-proj-fromstore0000",
      setEnv: "OPENAI_API_KEY",
      explicit: true,
    })
    expect(restarted.desc.auth).toMatchObject({
      mode: "api-key",
      provider: "openai",
      credentialSource: "providers-store",
      setEnv: "OPENAI_API_KEY",
      fingerprint: "api-key · sk-proj-…0000",
    })
    expect(restarted.desc.adapterProvider).toBe("openai")
  })

  it("(3) resolved mode with no credential anywhere ⇒ restart FAILS LOUD and registers no new session", async () => {
    const { resolver, captured } = makeAuthResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "claude-code",
      auth: {
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    })
    const countBefore = registry.list().length

    await expect(
      restartAgentSession(registry, resolver, prev, {
        forceAgentResume: true,
        // No token configured anywhere this time — the previously-pinned
        // credential is gone from config, same as e.g. a revoked/rotated
        // token never re-entered.
        loadDefaultsConfig: async () => undefined,
      }),
    ).rejects.toThrow(/missing_auth_credential/)

    // The stub only records into `captured` AFTER the fail-fast check —
    // empty means the throw happened before a session could ever spawn.
    expect(captured).toHaveLength(0)
    expect(registry.list()).toHaveLength(countBefore)
  })

  it("(4) prior descriptor with NO auth echo resolves from config defaults, same as a fresh spawn", async () => {
    const { resolver, captured } = makeAuthResolver(CODEX_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "codex",
      // No `auth` at all — e.g. this session ran ambient/unconfigured.
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: async () => ({
        adapters: { codex: { auth: { mode: "api-key", apiKey: "sk-proj-configdefault1234" } } },
      }),
    })

    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      credential: "sk-proj-configdefault1234",
      explicit: true,
    })
    expect(restarted.desc.auth).toMatchObject({
      mode: "api-key",
      provider: "openai",
      credentialSource: "explicit-config",
      setEnv: "OPENAI_API_KEY",
      fingerprint: "api-key · sk-proj-…1234",
    })
  })

  it("an adapter with no authDescriptor (e.g. hermes) skips auth resolution on restart — not an error", async () => {
    const { resolver, captured } = makeAuthResolver(undefined)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "hermes",
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
    })

    expect(captured[0]?.auth).toBeUndefined()
    expect(restarted.desc.auth).toBeUndefined()
  })
})
