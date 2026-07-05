/**
 * `agentproto auth login` / `agentproto auth logout` — driven through the
 * public `runAuth` entrypoint.
 *
 * `login` is exercised end-to-end against a mocked RFC 8628 device-flow
 * server (agentproto-host.json discovery + device-authorization + token
 * poll), the same shape `@agentproto/auth`'s `device-code` flow engine
 * speaks. `node:child_process` is mocked so the engine's best-effort
 * `openBrowser` never actually spawns anything. Real filesystem writes go to
 * a throwaway `AGENTPROTO_HOME`.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// device-grant.ts (inside @agentproto/auth) shells out to open a browser via
// `node:child_process` execFile — no-op it so tests never spawn one.
vi.mock("node:child_process", () => ({
  execFile: (_c: string, _a: string[], cb: (e: unknown, r: unknown) => void) =>
    cb(null, { stdout: "" }),
}))

import { runAuth } from "../commands/auth.js"
import { readHost } from "../util/credentials.js"

const HOST = "wss://tunnel.example.test"
const HTTP_HOST = "https://tunnel.example.test"
const DEVICE_AUTH = `${HTTP_HOST}/oauth/device`
const TOKEN_ENDPOINT = `${HTTP_HOST}/oauth/token`
const REVOKE_ENDPOINT = `${HTTP_HOST}/oauth/revoke`

function jsonRes(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Not Found",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function grantOf(init?: RequestInit): string | null {
  return new URLSearchParams(String(init?.body ?? "")).get("grant_type")
}

/** Mock RFC 8628 server: PRM discovery 404s (this host doesn't speak
 *  auth.md), agentproto-host.json fallback succeeds, then the usual
 *  device-authorization + token-poll dance. */
function stubDeviceFlowServer(
  tokenResponse: Record<string, unknown>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${HTTP_HOST}/.well-known/oauth-protected-resource`) {
      return jsonRes({}, false, 404)
    }
    if (url === `${HTTP_HOST}/.well-known/agentproto-host.json`) {
      return jsonRes({
        device_authorization_endpoint: DEVICE_AUTH,
        token_endpoint: TOKEN_ENDPOINT,
        revocation_endpoint: REVOKE_ENDPOINT,
      })
    }
    if (url === DEVICE_AUTH) {
      return jsonRes({
        device_code: "dc-1",
        user_code: "ABCD-1234",
        verification_uri: "https://approve.example.test/x",
        verification_uri_complete: "https://approve.example.test/x?code=ABCD-1234",
        expires_in: 300,
        interval: 0,
      })
    }
    if (url === TOKEN_ENDPOINT) {
      expect(grantOf(init)).toBe("urn:ietf:params:oauth:grant-type:device_code")
      return jsonRes(tokenResponse)
    }
    if (url === REVOKE_ENDPOINT) {
      return jsonRes({})
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

let fakeHome = ""

function silence(): { restore: () => void } {
  const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true)
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
  return {
    restore: () => {
      outSpy.mockRestore()
      errSpy.mockRestore()
    },
  }
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "agp-auth-login-"))
  process.env["AGENTPROTO_HOME"] = fakeHome
})

afterEach(() => {
  delete process.env["AGENTPROTO_HOME"]
  rmSync(fakeHome, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("agentproto auth login", () => {
  it("runs the device-code ceremony against a mock RFC 8628 server and persists a usable credential", async () => {
    stubDeviceFlowServer({
      access_token: "gdt_fresh",
      token_type: "Bearer",
      refresh_token: "gdr_fresh",
      expires_in: 3600,
      scope: "tunnel:connect agent-cli:dispatch",
      subject: "user-42",
      revocation_id: "rev-42",
    })
    const { restore } = silence()

    const code = await runAuth([
      "login",
      "--host",
      HOST,
      "--label",
      "test-device",
    ])
    restore()

    expect(code).toBe(0)
    const cred = await readHost(HOST)
    expect(cred?.token).toBe("gdt_fresh")
    expect(cred?.tokenType).toBe("Bearer")
    expect(cred?.refreshToken).toBe("gdr_fresh")
    expect(cred?.scope).toBe("tunnel:connect agent-cli:dispatch")
    expect(cred?.subject).toBe("user-42")
    expect(cred?.revocationId).toBe("rev-42")
    expect(cred?.deviceLabel).toBe("test-device")
    expect(cred?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("returns 1 and persists nothing when the user denies approval", async () => {
    stubDeviceFlowServer({ error: "access_denied" })
    const { restore } = silence()

    const code = await runAuth(["login", "--host", HOST])
    restore()

    expect(code).toBe(1)
    expect(await readHost(HOST)).toBeNull()
  })
})

describe("agentproto auth logout", () => {
  it("revokes server-side via the stored revocationId, then removes the local credential", async () => {
    stubDeviceFlowServer({
      access_token: "gdt_fresh",
      expires_in: 3600,
      revocation_id: "rev-42",
    })
    const { restore: restoreLogin } = silence()
    expect(await runAuth(["login", "--host", HOST])).toBe(0)
    restoreLogin()

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${HTTP_HOST}/.well-known/agentproto-host.json`) {
        return jsonRes({
          client_id: "agentproto-cli",
          device_authorization_endpoint: DEVICE_AUTH,
          token_endpoint: TOKEN_ENDPOINT,
          revocation_endpoint: REVOKE_ENDPOINT,
        })
      }
      if (url === REVOKE_ENDPOINT) {
        const params = new URLSearchParams(String(init?.body ?? ""))
        expect(params.get("revocation_id")).toBe("rev-42")
        return jsonRes({})
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const { restore: restoreLogout } = silence()
    const code = await runAuth(["logout", "--host", HOST])
    restoreLogout()

    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith(
      REVOKE_ENDPOINT,
      expect.anything(),
    )
    expect(await readHost(HOST)).toBeNull()
  })
})
