import { describe, expect, it } from "vitest"
import {
  SessionsApi,
  envCredentialSource,
  keychainCredentialSource,
  normalizeSessionId,
  toCliSessionId,
  type CloudCredential,
} from "../sessions-api.js"

/** Fixture fetch: routes a request to a canned Response. Records calls. */
function fixtureFetch(
  handler: (url: string, init: RequestInit) => Response,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const i = init ?? {}
    calls.push({ url: u, init: i })
    return handler(u, i)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Credential source with a readable call counter — proves the 401 path
 *  re-reads exactly once. */
function countingCredentials(
  ...credentials: CloudCredential[]
): { get: () => Promise<CloudCredential>; reads: () => number } {
  let i = 0
  let reads = 0
  return {
    async get() {
      reads++
      const cred = credentials[Math.min(i, credentials.length - 1)]
      i++
      if (!cred) throw new Error("credential fixture exhausted")
      return cred
    },
    reads: () => reads,
  }
}

describe("id normalization", () => {
  it("maps session_<x> to the API's cse_<x> spelling", () => {
    expect(normalizeSessionId("session_abc123")).toBe("cse_abc123")
  })

  it("keeps cse_<x> as-is and trims whitespace", () => {
    expect(normalizeSessionId("cse_abc123")).toBe("cse_abc123")
    expect(normalizeSessionId("  session_abc123 ")).toBe("cse_abc123")
  })

  it("rejects a malformed id instead of interpolating it into a path", () => {
    expect(() => normalizeSessionId("bogus")).toThrow(/unrecognized session id/)
    expect(() => normalizeSessionId("../../etc")).toThrow(
      /unrecognized session id/,
    )
  })

  it("maps ids to the CLI's session_<x> spelling", () => {
    expect(toCliSessionId("cse_abc123")).toBe("session_abc123")
    expect(toCliSessionId("session_abc123")).toBe("session_abc123")
  })
})

describe("SessionsApi", () => {
  it("GETs a session by its normalized id with the vendor headers", async () => {
    const { fetchImpl, calls } = fixtureFetch(() =>
      json({ response_shape: { id: "cse_abc", title: "t", status: "active" } }),
    )
    const api = new SessionsApi({
      credentials: {
        get: async () => ({ accessToken: "tok", orgUuid: "org-1" }),
      },
      fetchImpl,
    })
    const res = await api.getSession("session_abc")
    expect(res.response_shape.id).toBe("cse_abc")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/code/sessions/cse_abc")
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer tok")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["x-organization-uuid"]).toBe("org-1")
  })

  it("listEvents round-trips the resume_cursor as the next page cursor", async () => {
    const { fetchImpl, calls } = fixtureFetch(url =>
      url.includes("cursor=cur-1")
        ? json({ data: [{ created_at: "2", event_id: "e2", event_type: "result", payload: {} }], resume_cursor: "cur-2" })
        : json({
            data: [
              { created_at: "1", event_id: "e1", event_type: "assistant", payload: {} },
              { created_at: "0", event_id: "e0", event_type: "user", payload: {} },
            ],
            resume_cursor: "cur-1",
          }),
    )
    const api = new SessionsApi({
      credentials: { get: async () => ({ accessToken: "tok" }) },
      fetchImpl,
    })
    const page1 = await api.listEvents("session_abc")
    expect(page1.resume_cursor).toBe("cur-1")
    expect(page1.data.map(e => e.event_id)).toEqual(["e1", "e0"])
    expect(calls[0]!.url).toBe(
      "https://api.anthropic.com/v1/code/sessions/cse_abc/events",
    )

    const page2 = await api.listEvents("session_abc", {
      cursor: page1.resume_cursor,
    })
    expect(page2.data[0]?.event_type).toBe("result")
    expect(calls[1]!.url).toBe(
      "https://api.anthropic.com/v1/code/sessions/cse_abc/events?cursor=cur-1",
    )
  })

  it("listSessions passes the limit through", async () => {
    const { fetchImpl, calls } = fixtureFetch(() =>
      json({ data: [], resume_token: "r" }),
    )
    const api = new SessionsApi({
      credentials: { get: async () => ({ accessToken: "tok" }) },
      fetchImpl,
    })
    await api.listSessions({ limit: 25 })
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/code/sessions?limit=25")
  })

  it("re-reads the credential once on 401, then succeeds", async () => {
    let first = true
    const { fetchImpl } = fixtureFetch(() => {
      if (first) {
        first = false
        return json({ error: "unauthorized" }, 401)
      }
      return json({ response_shape: { id: "cse_abc", title: "t", status: "active" } })
    })
    const credentials = countingCredentials(
      { accessToken: "stale-tok" },
      { accessToken: "fresh-tok" },
    )
    const api = new SessionsApi({ credentials, fetchImpl })
    const res = await api.getSession("session_abc")
    expect(res.response_shape.id).toBe("cse_abc")
    expect(credentials.reads()).toBe(2)
  })

  it("fails with the login hint after the one 401 retry is spent", async () => {
    const { fetchImpl } = fixtureFetch(() =>
      json({ error: "unauthorized" }, 401),
    )
    const credentials = countingCredentials({ accessToken: "tok" })
    const api = new SessionsApi({ credentials, fetchImpl })
    await expect(api.getSession("session_abc")).rejects.toThrow(
      /unauthorized \(401\) — run `claude auth login`/,
    )
    expect(credentials.reads()).toBe(2)
  })

  it("surfaces non-401 HTTP failures with method + status", async () => {
    const { fetchImpl } = fixtureFetch(() => json({ error: "nope" }, 500))
    const api = new SessionsApi({
      credentials: { get: async () => ({ accessToken: "tok" }) },
      fetchImpl,
    })
    await expect(api.getSession("session_abc")).rejects.toThrow(
      /GET \/v1\/code\/sessions\/cse_abc failed: HTTP 500/,
    )
  })
})

describe("credential sources", () => {
  it("env source reads the token + org and hints at the login when unset", async () => {
    const source = envCredentialSource({
      CLAUDE_CLOUD_OAUTH_TOKEN: "env-tok",
      CLAUDE_CLOUD_ORG_UUID: "org-9",
    })
    expect(await source.get()).toEqual({
      accessToken: "env-tok",
      orgUuid: "org-9",
    })

    const empty = envCredentialSource({})
    await expect(empty.get()).rejects.toThrow(/run `claude auth login`/)
  })

  it("keychain source parses the security JSON + org from ~/.claude.json", async () => {
    const source = keychainCredentialSource({
      execFileImpl: async (cmd, args) => {
        expect(cmd).toBe("security")
        expect(args).toEqual([
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-w",
        ])
        return {
          stdout: JSON.stringify({ claudeAiOauth: { accessToken: "kc-tok" } }),
        }
      },
      readFileSyncImpl: async path => {
        expect(String(path)).toMatch(/\.claude\.json$/)
        return JSON.stringify({
          oauthAccount: { organizationUuid: "org-kc" },
        })
      },
      homedir: () => "/home/user",
    })
    expect(await source.get()).toEqual({
      accessToken: "kc-tok",
      orgUuid: "org-kc",
    })
  })

  it("keychain source fails closed when the entry lacks an access token", async () => {
    const source = keychainCredentialSource({
      execFileImpl: async () => ({ stdout: JSON.stringify({}) }),
      readFileSyncImpl: async () => "{}",
      homedir: () => "/home/user",
    })
    await expect(source.get()).rejects.toThrow(/run `claude auth login`/)
  })
})
