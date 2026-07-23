/**
 * Coverage for the LAZY in-place resume "money bug" (PR-1): the registry's
 * `resumeAgent` hook (triggered when the first prompt arrives for an agent-cli
 * row killed by a daemon restart) used to call `startSession` with NO `auth`
 * spec at all — so a session pinned to `subscription` (or a named profile)
 * silently came back billing on whatever the daemon's ambient env held (e.g. a
 * leaked `ANTHROPIC_API_KEY`). This is byte-for-byte the bug `session-restart-
 * core.ts` was created to fix for `session_restart`; the fix is now shared via
 * `resolveResumeAuth` and threaded through the lazy hook.
 *
 * Two layers, both with injected stubs (same style as session-restart-auth.test.ts):
 *   1. `resolveResumeAuth` directly — the extracted, shared re-resolution core.
 *   2. The wired lazy hook end-to-end through the registry — a re-implementation
 *      of index.ts's `resumeAgent` closure (same shape) attached to a real
 *      registry, driven by a prompt to a seeded killed row, with a `startSession`
 *      stub that replicates the driver's own `missing_auth_credential` fail-fast
 *      so the fail-loud contract is proven without depending on the driver.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const storeKeys = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }))
vi.mock("../providers-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../providers-store.js")>()
  return { ...actual, getProviderKey: vi.fn(async (p: string) => storeKeys.value[p]) }
})

import { resolveResumeAuth, RestartOverrideError } from "../session-restart-core.js"
import { createSessionsRegistry } from "../sessions.js"
import type {
  AgentSessionLike,
  AgentStreamEvent,
  AgentSessionResumer,
  SessionDescriptor,
} from "../sessions.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"
import type { AuthProfile } from "@agentproto/auth"

let acpCounter = 0
function fakeAgentSession(sessionId?: string): AgentSessionLike {
  return {
    sessionId: sessionId ?? `acp_${acpCounter++}`,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

const CODEX_DESC: AdapterAuthDescriptor = { provider: "openai" }
const CLAUDE_CODE_DESC: AdapterAuthDescriptor = {
  provider: "anthropic",
  authEnforce: "always",
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    unsetEnvAdd: ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BASE_URL"],
  },
}

/** Minimal descriptor carrying just what `resolveResumeAuth` reads. */
function descWith(auth?: SessionDescriptor["auth"]): SessionDescriptor {
  return { auth } as unknown as SessionDescriptor
}

describe("resolveResumeAuth — shared billing-auth re-resolution", () => {
  beforeEach(() => {
    storeKeys.value = {}
  })

  it("(a) subscription echo re-resolves the subscription credential from config — NOT ambient", async () => {
    const res = await resolveResumeAuth(
      descWith({
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      }),
      { authDescriptor: CLAUDE_CODE_DESC },
      {
        adapterSlug: "claude-code",
        loadDefaultsConfig: async () => ({
          adapters: { "claude-code": { auth: { token: "sk-ant-oat01-freshtoken9999" } } },
        }),
      },
    )
    expect(res.authSpec).toMatchObject({
      mode: "subscription",
      credential: "sk-ant-oat01-freshtoken9999",
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      explicit: true,
      enforce: "always",
    })
  })

  it("(b) a pinned named profile re-validates eligibility and resolves with the profile's OWN credential", async () => {
    const profile: AuthProfile = {
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "agentproto.auth.anthropic.sub",
    }
    const res = await resolveResumeAuth(descWith(), { authDescriptor: CLAUDE_CODE_DESC }, {
      adapterSlug: "claude-code",
      model: "claude-opus-4-6",
      accessProfileRef: "anthropic-sub",
      resolveAccessProfile: async () => ({ profile, credential: "sk-ant-oat01-profilecred" }),
    })
    expect(res.authSpec).toMatchObject({
      mode: "subscription",
      credential: "sk-ant-oat01-profilecred",
      explicit: true,
    })
  })

  it("(b') a pinned profile ineligible for the adapter's route is REJECTED (fail-loud, no silent wallet swap)", async () => {
    const wrongProfile: AuthProfile = {
      id: "openai-key",
      endpoint: "openai",
      method: "api-key",
      credentialRef: "agentproto.auth.openai.key",
    }
    await expect(
      resolveResumeAuth(descWith(), { authDescriptor: CLAUDE_CODE_DESC }, {
        adapterSlug: "claude-code",
        model: "claude-opus-4-6",
        accessProfileRef: "openai-key",
        resolveAccessProfile: async () => ({ profile: wrongProfile, credential: "sk-proj-x" }),
      }),
    ).rejects.toThrow(/not eligible/)
  })

  it("source-backed profile (spawn-only) falls back to the base mode path", async () => {
    const res = await resolveResumeAuth(
      descWith({
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      }),
      { authDescriptor: CLAUDE_CODE_DESC },
      {
        adapterSlug: "claude-code",
        accessProfileRef: "src-backed",
        // Mirrors resolveAccessProfileFromStore's fail-loud on a source-backed
        // profile — the helper must treat this as "not credential-backed here"
        // and fall through to the base mode path, not propagate.
        resolveAccessProfile: async () => {
          throw new RestartOverrideError("source-backed")
        },
        loadDefaultsConfig: async () => ({
          adapters: { "claude-code": { auth: { token: "sk-ant-oat01-basefallback" } } },
        }),
      },
    )
    expect(res.authSpec).toMatchObject({
      mode: "subscription",
      credential: "sk-ant-oat01-basefallback",
    })
  })

  it("api-key echo re-resolves from the providers store", async () => {
    storeKeys.value = { openai: "sk-proj-fromstore0000" }
    const res = await resolveResumeAuth(
      descWith({
        mode: "api-key",
        fingerprint: "api-key · sk-proj-…OLD1",
        provider: "openai",
        credentialSource: "providers-store",
        setEnv: "OPENAI_API_KEY",
      }),
      { authDescriptor: CODEX_DESC },
      { adapterSlug: "codex", loadDefaultsConfig: async () => undefined },
    )
    expect(res.authSpec).toMatchObject({
      mode: "api-key",
      credential: "sk-proj-fromstore0000",
      explicit: true,
    })
  })

  it("an adapter with no authDescriptor resolves nothing (ambient — e.g. hermes)", async () => {
    const res = await resolveResumeAuth(descWith(), {}, { adapterSlug: "hermes" })
    expect(res.authSpec).toBeUndefined()
    expect(res.authEcho).toBeUndefined()
  })
})

/**
 * Stub that replicates the driver's own `missing_auth_credential` fail-fast:
 * an ENGAGED spec (enforce:"always" or explicit:true) with no credential
 * throws before any session is created, exactly as the real driver would.
 */
type CapturedAuth = {
  mode: "subscription" | "api-key"
  credential?: string
  setEnv: string
  explicit: boolean
  enforce: "always" | "when-configured"
}

function makeLazyResumeHook(
  authDescriptor: AdapterAuthDescriptor | undefined,
  deps: {
    loadDefaultsConfig?: () => Promise<import("../spawn-defaults.js").SpawnDefaultsConfig | undefined>
    defaultModel?: string
  } = {},
): { hook: AgentSessionResumer; captured: { auth?: CapturedAuth }[] } {
  const captured: { auth?: CapturedAuth }[] = []
  const adapter = {
    ...(authDescriptor ? { authDescriptor } : {}),
    ...(deps.defaultModel ? { defaultModel: deps.defaultModel } : {}),
    startSession: async (o: { resumeSessionId?: string; auth?: CapturedAuth }) => {
      const authSpec = o.auth
      const engaged = !!authSpec && (authSpec.enforce === "always" || authSpec.explicit === true)
      if (authSpec && engaged && !authSpec.credential) {
        throw new Error(
          `missing_auth_credential: auth mode "${authSpec.mode}" requires an explicit credential`,
        )
      }
      captured.push({ auth: authSpec })
      return fakeAgentSession(o.resumeSessionId)
    },
  }
  // Mirror index.ts's resumeAgent closure exactly (resolveResumeAuth → thread
  // auth/base_url into startSession, catch → null so a failed resume never
  // starts a session on ambient env).
  const hook: AgentSessionResumer = async ({ resumeSessionId, descriptor }) => {
    try {
      const { authSpec } = await resolveResumeAuth(
        descriptor,
        adapter as { authDescriptor?: AdapterAuthDescriptor; defaultModel?: string },
        {
          adapterSlug: descriptor.adapterSlug!,
          ...(descriptor.model ? { model: descriptor.model } : {}),
          ...(descriptor.route ? { route: descriptor.route } : {}),
          ...(descriptor.accessProfile?.profileRef
            ? { accessProfileRef: descriptor.accessProfile.profileRef }
            : {}),
          prefix: "resume",
          ...(deps.loadDefaultsConfig ? { loadDefaultsConfig: deps.loadDefaultsConfig } : {}),
        },
      )
      return await adapter.startSession({
        resumeSessionId,
        ...(authSpec ? { auth: authSpec as unknown as CapturedAuth } : {}),
      })
    } catch {
      return null
    }
  }
  return { hook, captured }
}

function seedKilledRow(
  persistPath: string,
  extra: Record<string, unknown>,
): string {
  const id = "sess_resume01"
  writeFileSync(
    persistPath,
    JSON.stringify({
      savedAt: "2026-07-23T00:00:00Z",
      sessions: [
        {
          id,
          kind: "agent-cli",
          workspaceSlug: "default",
          command: "claude (agent)",
          pid: null,
          status: "running",
          startedAt: "2026-07-23T00:00:00Z",
          adapterSlug: "claude-code",
          adapterSessionId: "acp-resume-me",
          cwd: "/tmp",
          ...extra,
        },
      ],
    }),
  )
  return id
}

describe("lazy in-place resume — billing-auth threading (wired hook)", () => {
  let persistPath: string
  beforeEach(() => {
    storeKeys.value = {}
    persistPath = join(mkdtempSync(join(tmpdir(), "resume-auth-")), "sessions.json")
  })

  it("threads mode:subscription into startSession from the descriptor's auth echo — not ambient", async () => {
    const id = seedKilledRow(persistPath, {
      auth: {
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    })
    const { hook, captured } = makeLazyResumeHook(CLAUDE_CODE_DESC, {
      loadDefaultsConfig: async () => ({
        adapters: { "claude-code": { auth: { token: "sk-ant-oat01-fresh4321" } } },
      }),
    })
    const reg = createSessionsRegistry({ persistPath, resumeAgent: hook })

    await reg.sendPrompt(id, "ping")

    expect(captured).toHaveLength(1)
    expect(captured[0]?.auth).toMatchObject({
      mode: "subscription",
      credential: "sk-ant-oat01-fresh4321",
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      explicit: true,
    })
    expect(reg.get(id)?.status).toBe("running")
    reg.shutdown()
  })

  it("a subscription-pinned row with NO resolvable credential FAILS LOUD — no ambient session created", async () => {
    const id = seedKilledRow(persistPath, {
      auth: {
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    })
    const { hook, captured } = makeLazyResumeHook(CLAUDE_CODE_DESC, {
      // No token configured anywhere — a rotated/revoked credential never
      // re-entered. resolveResumeAuth resolves the enforce:"always" spec with
      // no credential → the startSession stub (driver) throws → hook returns
      // null → the row stays dead rather than resuming on ambient env.
      loadDefaultsConfig: async () => undefined,
    })
    const reg = createSessionsRegistry({ persistPath, resumeAgent: hook })

    await expect(reg.sendPrompt(id, "ping")).rejects.toThrow()

    // The stub only records AFTER its fail-fast — empty proves no session was
    // ever created on ambient billing.
    expect(captured).toHaveLength(0)
    expect(reg.get(id)?.status).not.toBe("running")
    reg.shutdown()
  })
})
