import { describe, it, expect, vi } from "vitest"
import type { DiscoverCtx } from "@agentproto/provider-kit"
import { gemini, geminiCapabilities } from "../index.js"

function makeCtx(files: Record<string, string>, env: Record<string, string | undefined> = {}): DiscoverCtx {
  return {
    homeDir: "/home/test",
    env,
    readFile: async (path: string) => (path in files ? files[path]! : null),
    warn: vi.fn(),
  }
}

describe("geminiCapabilities", () => {
  it("reports the oauth login as the credential source when selectedType is oauth AND the login file exists", async () => {
    const ctx = makeCtx({
      "/home/test/.gemini/settings.json": JSON.stringify({
        security: { auth: { selectedType: "oauth-personal" } },
      }),
      "/home/test/.gemini/oauth_creds.json": JSON.stringify({ access_token: "should-never-appear" }),
    })
    const caps = await geminiCapabilities(gemini, ctx)
    expect(caps.source).toBe("discovered")
    expect(caps.discoverable).toBe("parse")
    expect(caps.providers).toEqual([
      {
        id: "google",
        billingEndpoint: "google",
        cred: { present: true, source: { kind: "oauth-file", path: "~/.gemini/oauth_creds.json" } },
      },
    ])
    const serialized = JSON.stringify(caps)
    expect(serialized).not.toContain("should-never-appear")
  })

  it("falls back to the api-key env var when selectedType is not oauth", async () => {
    const ctx = makeCtx(
      {
        "/home/test/.gemini/settings.json": JSON.stringify({
          security: { auth: { selectedType: "gemini-api-key" } },
        }),
      },
      { GOOGLE_GENERATIVE_AI_API_KEY: "sk-should-not-be-echoed" },
    )
    const caps = await geminiCapabilities(gemini, ctx)
    expect(caps.providers[0]?.cred).toEqual({
      present: true,
      source: { kind: "env", var: "GOOGLE_GENERATIVE_AI_API_KEY" },
    })
    const serialized = JSON.stringify(caps)
    expect(serialized).not.toContain("sk-should-not-be-echoed")
  })

  it("reports absent when oauth is selected but the login file is missing, and no api key is set", async () => {
    const ctx = makeCtx({
      "/home/test/.gemini/settings.json": JSON.stringify({
        security: { auth: { selectedType: "oauth-personal" } },
      }),
    })
    const caps = await geminiCapabilities(gemini, ctx)
    expect(caps.providers[0]?.cred.present).toBe(false)
  })

  it("never throws on a malformed settings.json", async () => {
    const warn = vi.fn()
    const ctx = makeCtx({ "/home/test/.gemini/settings.json": "{not json" })
    ctx.warn = warn
    const caps = await geminiCapabilities(gemini, ctx)
    expect(caps.providers[0]?.cred.present).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("declares mechanism catalog for models", async () => {
    const caps = await geminiCapabilities(gemini, makeCtx({}))
    expect(caps.models).toEqual({ mechanism: "catalog" })
  })
})
