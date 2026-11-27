/**
 * `app serve` beyond loopback: the static page stays open, tool calls and
 * uploads need the access token (bearer or the cookie a `?t=` visit sets).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_ENV,
  isLoopbackHost,
  newAccessToken,
  resolveAccessToken,
  tokensEqual,
} from "../app-serve-auth.js"
import { buildBridgeScript, createAppServeRequestHandler } from "../app-serve.js"

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "LOCALHOST"])("%s is loopback", h => {
    expect(isLoopbackHost(h)).toBe(true)
  })
  it.each(["0.0.0.0", "::", "192.168.1.5", "10.0.0.1", "example.com", "127.0.0.1.evil.test"])("%s is not", h => {
    expect(isLoopbackHost(h)).toBe(false)
  })
})

describe("tokens", () => {
  it("generates distinct 256-bit url-safe tokens and compares in constant time", () => {
    const a = newAccessToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newAccessToken()).not.toBe(a)
    expect(tokensEqual(a, a)).toBe(true)
    expect(tokensEqual(a, `${a}x`)).toBe(false)
    expect(tokensEqual(a, "")).toBe(false)
  })
})

describe("resolveAccessToken", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-serve-auth-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const defaultFile = () => join(dir, ".agentproto", "app-serve.token")

  it("needs no token on loopback, or when explicitly opted out", async () => {
    expect((await resolveAccessToken({ host: "127.0.0.1", env: {}, defaultFile: defaultFile() })).source).toBe("none")
    expect((await resolveAccessToken({ host: "0.0.0.0", env: {}, insecureNoAuth: true, defaultFile: defaultFile() })).source).toBe("none")
  })

  it("generates a 0600 token file beyond loopback, then reuses it", async () => {
    const first = await resolveAccessToken({ host: "0.0.0.0", env: {}, defaultFile: defaultFile() })
    expect(first.source).toBe("generated")
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(((await stat(defaultFile())).mode & 0o777).toString(8)).toBe("600")
    expect((await readFile(defaultFile(), "utf8")).trim()).toBe(first.token)
    const again = await resolveAccessToken({ host: "0.0.0.0", env: {}, defaultFile: defaultFile() })
    expect(again).toMatchObject({ source: "file", token: first.token })
  })

  it("prefers an explicit token file, then the env var over the default file", async () => {
    const custom = join(dir, "custom.token")
    await writeFile(custom, "a-token-from-a-file-0123456789\n")
    expect(await resolveAccessToken({ host: "0.0.0.0", tokenFile: custom, env: {}, defaultFile: defaultFile() })).toMatchObject({
      source: "file",
      token: "a-token-from-a-file-0123456789",
    })
    expect(
      await resolveAccessToken({ host: "0.0.0.0", env: { [ACCESS_TOKEN_ENV]: "env-token-0123456789" }, defaultFile: defaultFile() }),
    ).toMatchObject({ source: "env", token: "env-token-0123456789" })
  })

  it("creates a missing explicit token file", async () => {
    const custom = join(dir, "sub", "new.token")
    const r = await resolveAccessToken({ host: "0.0.0.0", tokenFile: custom, env: {}, defaultFile: defaultFile() })
    expect(r.source).toBe("generated")
    expect((await readFile(custom, "utf8")).trim()).toBe(r.token)
  })

  it("replaces a token file too short to be a secret", async () => {
    await mkdir(join(dir, ".agentproto"), { recursive: true })
    await writeFile(defaultFile(), "x\n")
    const r = await resolveAccessToken({ host: "0.0.0.0", env: {}, defaultFile: defaultFile() })
    expect(r.source).toBe("generated")
  })
})

describe("app serve request handler with an access token", () => {
  const TOKEN = "t".repeat(43)
  let dir: string
  let base: string
  let close: () => Promise<void>
  let toolCalls: number

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-serve-gate-"))
    await mkdir(join(dir, ".agentproto", "ui"), { recursive: true })
    await writeFile(join(dir, ".agentproto", "ui", "index.html"), "<html><head></head><body>SHELL-MARKER</body></html>")
    toolCalls = 0
    const handler = createAppServeRequestHandler({
      uiRoot: join(dir, ".agentproto", "ui"),
      appDir: dir,
      bridgeScript: buildBridgeScript("/__agentproto/tool-call"),
      allowedTools: undefined,
      getClient: async () => {
        toolCalls++
        throw new Error("no daemon in this test")
      },
      accessToken: TOKEN,
    })
    const server = createServer(handler)
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
    const addr = server.address()
    base = `http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`
    close = () => new Promise<void>(r => server.close(() => r()))
  })
  afterEach(async () => {
    await close()
    await rm(dir, { recursive: true, force: true })
  })

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name: "directory_list", args: { path: "/" } }),
    })

  it("serves the static shell and its assets without a credential", async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("SHELL-MARKER")
    expect((await fetch(`${base}/apps/@acme/x/ui`)).status).toBe(200)
  })

  it("refuses a tool call with no credential, a wrong bearer or a wrong cookie, and never reaches the daemon client", async () => {
    const bad: Record<string, string>[] = [
      {},
      { authorization: "Bearer nope" },
      { authorization: "Basic abc" },
      { cookie: `${ACCESS_COOKIE}=nope` },
      { cookie: "other=1" },
    ]
    for (const headers of bad) {
      const res = await post("/__agentproto/tool-call", headers)
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toContain("Bearer")
      expect(await res.json()).toEqual({ error: "unauthorized" })
    }
    expect(toolCalls).toBe(0)
  })

  it("refuses uploads and any other /__agentproto/ route without a credential", async () => {
    expect((await fetch(`${base}/__agentproto/upload?filename=a.txt`, { method: "POST", body: "x" })).status).toBe(401)
    expect((await fetch(`${base}/__agentproto/anything`)).status).toBe(401)
  })

  it("lets a tool call through with the bearer token (it then reaches the daemon client)", async () => {
    const res = await post("/__agentproto/tool-call", { authorization: `Bearer ${TOKEN}` })
    expect(res.status).not.toBe(401)
    expect(toolCalls).toBe(1)
  })

  it("trades ?t=<token> for an HttpOnly SameSite=Strict cookie, drops it from the URL, and the cookie then authorizes", async () => {
    const res = await fetch(`${base}/?t=${TOKEN}&x=1`, { redirect: "manual" })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/?x=1")
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie).toContain(`${ACCESS_COOKIE}=${TOKEN}`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).not.toContain("Secure")
    const ok = await post("/__agentproto/tool-call", { cookie: `${ACCESS_COOKIE}=${TOKEN}` })
    expect(ok.status).not.toBe(401)
  })

  it("marks the cookie Secure behind an https proxy", async () => {
    const res = await fetch(`${base}/?t=${TOKEN}`, { redirect: "manual", headers: { "x-forwarded-proto": "https" } })
    expect(res.headers.get("set-cookie")).toContain("Secure")
  })

  it("ignores a wrong ?t= (no cookie, page still served) and never accepts the token on a POST query", async () => {
    const res = await fetch(`${base}/?t=wrong`, { redirect: "manual" })
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect((await post(`/__agentproto/tool-call?t=${TOKEN}`)).status).toBe(401)
  })

  it("answers a CORS preflight without a credential (it carries no data)", async () => {
    const res = await fetch(`${base}/__agentproto/tool-call`, { method: "OPTIONS" })
    expect(res.status).toBe(204)
  })
})

describe("app serve request handler without an access token (loopback)", () => {
  it("is unchanged: no gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-serve-open-"))
    try {
      await mkdir(join(dir, ".agentproto", "ui"), { recursive: true })
      await writeFile(join(dir, ".agentproto", "ui", "index.html"), "<html><body>x</body></html>")
      const server = createServer(
        createAppServeRequestHandler({
          uiRoot: join(dir, ".agentproto", "ui"),
          appDir: dir,
          bridgeScript: "",
          allowedTools: undefined,
          getClient: async () => {
            throw new Error("no daemon")
          },
        }),
      )
      await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
      const addr = server.address()
      const base = `http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`
      const res = await fetch(`${base}/__agentproto/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      })
      expect(res.status).not.toBe(401)
      await new Promise<void>(r => server.close(() => r()))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
