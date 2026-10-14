import { describe, expect, it } from "vitest"
import {
  SessionsApi,
  envCredentialSource,
  eventSequence,
  keychainCredentialSource,
  normalizeSessionId,
  toCliSessionId,
  type CloudCredential,
  type CloudSessionEvent,
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

describe("eventSequence", () => {
  function ev(sequence_num: string): CloudSessionEvent {
    return {
      created_at: "0",
      event_id: "e",
      event_type: "assistant",
      sequence_num,
      payload: {},
    }
  }

  it("parses the string sequence_num to a number", () => {
    expect(eventSequence(ev("23"))).toBe(23)
    expect(eventSequence(ev("0"))).toBe(0)
  })

  it("returns null for a non-numeric sequence_num (the event is unorderable)", () => {
    expect(eventSequence(ev(""))).toBeNull()
    expect(eventSequence(ev("not-a-number"))).toBeNull()
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

  it("listEvents: no cursor = newest page (newest first); cursor = the next OLDER page", async () => {
    const { fetchImpl, calls } = fixtureFetch(url =>
      url.includes("cursor=11")
        ? json({
            data: [
              { created_at: "10", event_id: "e10", event_type: "assistant", sequence_num: "10", payload: {} },
              { created_at: "9", event_id: "e9", event_type: "user", sequence_num: "9", payload: {} },
            ],
            resume_cursor: "9",
          })
        : json({
            data: [
              { created_at: "12", event_id: "e12", event_type: "result", sequence_num: "12", payload: {} },
              { created_at: "11", event_id: "e11", event_type: "assistant", sequence_num: "11", payload: {} },
            ],
            resume_cursor: "11",
            next_cursor: "11",
          }),
    )
    const api = new SessionsApi({
      credentials: { get: async () => ({ accessToken: "tok" }) },
      fetchImpl,
    })
    // No cursor → the NEWEST page, newest first. resume_cursor is the OLDEST
    // seq on the page (11), which is also the first page's next_cursor.
    const page1 = await api.listEvents("session_abc")
    expect(page1.data.map(e => e.sequence_num)).toEqual(["12", "11"])
    expect(page1.resume_cursor).toBe("11")
    expect(page1.next_cursor).toBe("11")
    expect(calls[0]!.url).toBe(
      "https://api.anthropic.com/v1/code/sessions/cse_abc/events",
    )

    // Passing that cursor back pages BACKWARD to older events (seq < 11).
    const page2 = await api.listEvents("session_abc", {
      cursor: page1.resume_cursor,
    })
    expect(page2.data.map(e => e.sequence_num)).toEqual(["10", "9"])
    expect(page2.resume_cursor).toBe("9")
    expect(calls[1]!.url).toBe(
      "https://api.anthropic.com/v1/code/sessions/cse_abc/events?cursor=11",
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
