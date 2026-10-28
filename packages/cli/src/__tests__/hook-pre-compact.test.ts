/**
 * `agentproto hook pre-compact`: the command Claude Code runs, synchronously,
 * right before its own (auto) compaction. It asks the daemon for a checkpoint
 * of the daemon session it runs in and ALWAYS exits 0 with nothing on stdout:
 * a missing checkpoint must never break the compaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildPreCompactRequest, runHook } from "../commands/hook.js"

const SESSION_ENV = "AGENTPROTO_SESSION_ID"
const TOKEN = "tok_secret_daemon_token_123"

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hook-pre-compact-"))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("H1 buildPreCompactRequest", () => {
  const statOf = (path: string): number | undefined => {
    try {
      return statSync(path).size
    } catch {
      return undefined
    }
  }

  it("takes the daemon session id from the env, never the payload, and keys the occurrence on the transcript size", () => {
    const transcript = join(tmp, "t.jsonl")
    writeFileSync(transcript, "x".repeat(1234))
    const built = buildPreCompactRequest(
      { [SESSION_ENV]: "sess_daemon1" },
      { session_id: "claude-own-uuid", transcript_path: transcript, trigger: "auto", hook_event_name: "PreCompact" },
      statOf,
    )
    expect(built).toEqual({
      sessionId: "sess_daemon1",
      body: { reason: "native-pre-compact", occurrenceId: "pc-1234", trigger: "auto" },
    })
  })

  it("is undefined without an env id, or with a malformed one, even when the payload carries a session_id", () => {
    const payload = { session_id: "claude-own-uuid", trigger: "auto" }
    expect(buildPreCompactRequest({}, payload, statOf)).toBeUndefined()
    expect(buildPreCompactRequest({ [SESSION_ENV]: "" }, payload, statOf)).toBeUndefined()
    expect(buildPreCompactRequest({ [SESSION_ENV]: "sess/../x" }, payload, statOf)).toBeUndefined()
    expect(buildPreCompactRequest({ [SESSION_ENV]: "a b" }, payload, statOf)).toBeUndefined()
    expect(buildPreCompactRequest({ [SESSION_ENV]: "x".repeat(129) }, payload, statOf)).toBeUndefined()
  })

  it("falls back to pc-t<unix seconds> when transcript_path is missing or cannot be stat'ed", () => {
    const now = 1_761_667_200_000
    expect(buildPreCompactRequest({ [SESSION_ENV]: "sess_a" }, { trigger: "auto" }, statOf, now)?.body.occurrenceId).toBe(
      "pc-t1761667200",
    )
    expect(
      buildPreCompactRequest({ [SESSION_ENV]: "sess_a" }, { transcript_path: join(tmp, "nope.jsonl") }, statOf, now)
        ?.body.occurrenceId,
    ).toBe("pc-t1761667200")
    expect(
      buildPreCompactRequest({ [SESSION_ENV]: "sess_a" }, { transcript_path: 42 }, () => 7, now)?.body.occurrenceId,
    ).toBe("pc-t1761667200")
  })

  it("passes trigger through (auto, manual) and drops anything else", () => {
    const env = { [SESSION_ENV]: "sess_a" }
    expect(buildPreCompactRequest(env, { trigger: "auto" }, statOf)?.body.trigger).toBe("auto")
    expect(buildPreCompactRequest(env, { trigger: "manual" }, statOf)?.body.trigger).toBe("manual")
    const odd = buildPreCompactRequest(env, { trigger: "sideways" }, statOf)
    expect(odd).toBeDefined()
    expect(odd!.body).not.toHaveProperty("trigger")
  })
})

describe("H2 runHook(['pre-compact']) end to end", () => {
  interface Seen {
    path: string
    authorization?: string
    body: unknown
  }
  let server: Server | undefined
  let seen: Seen[]
  let stdout: string[]
  let stderr: string[]
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = [SESSION_ENV, "AGENTPROTO_DAEMON_URL", "AGENTPROTO_DAEMON_TOKEN"]

  beforeEach(() => {
    seen = []
    stdout = []
    stderr = []
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(r => server!.close(() => r()))
      server = undefined
    }
  })

  async function startDaemon(respond: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    server = createServer((req, res) => {
      let raw = ""
      req.setEncoding("utf8")
      req.on("data", c => (raw += c))
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          body: raw ? JSON.parse(raw) : undefined,
        })
        respond(req, res)
      })
    })
    await new Promise<void>(r => server!.listen(0, "127.0.0.1", () => r()))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  function pointAt(url: string): void {
    process.env.AGENTPROTO_DAEMON_URL = url
    process.env.AGENTPROTO_DAEMON_TOKEN = TOKEN
    process.env[SESSION_ENV] = "sess_daemon1"
  }

  const payload = () => {
    const transcript = join(tmp, "t.jsonl")
    writeFileSync(transcript, "y".repeat(321))
    return JSON.stringify({
      session_id: "claude-own-uuid",
      transcript_path: transcript,
      hook_event_name: "PreCompact",
      trigger: "auto",
      custom_instructions: null,
    })
  }

  const noSecret = () => {
    expect(stdout.join("")).not.toContain(TOKEN)
    expect(stderr.join("")).not.toContain(TOKEN)
    expect(stderr.join("")).not.toContain("claude-own-uuid")
  }

  it("POSTs the checkpoint with the daemon token, exits 0, prints nothing on stdout", async () => {
    pointAt(
      await startDaemon((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, checkpointId: "ckpt_1", path: "/x" }))
      }),
    )
    const code = await runHook(["pre-compact"], { readStdin: async () => payload() })
    expect(code).toBe(0)
    expect(seen).toEqual([
      {
        path: "/sessions/sess_daemon1/checkpoint",
        authorization: `Bearer ${TOKEN}`,
        body: { reason: "native-pre-compact", occurrenceId: "pc-321", trigger: "auto" },
      },
    ])
    expect(stdout).toEqual([])
    expect(stderr).toEqual([])
  })

  it("a 500 from the daemon: exit 0, one short stderr line, nothing on stdout", async () => {
    pointAt(
      await startDaemon((_req, res) => {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "checkpoint_failed", message: `boom ${TOKEN}` }))
      }),
    )
    const code = await runHook(["pre-compact"], { readStdin: async () => payload() })
    expect(code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual(["agentproto hook pre-compact: checkpoint skipped (HTTP 500)\n"])
    noSecret()
  })

  it("a daemon that hangs: gives up at the injected timeout, exit 0", async () => {
    pointAt(await startDaemon(() => {}))
    const started = Date.now()
    const code = await runHook(["pre-compact"], { readStdin: async () => payload(), timeoutMs: 200 })
    expect(code).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(seen).toHaveLength(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual(["agentproto hook pre-compact: checkpoint skipped (timeout)\n"])
    noSecret()
  })

  it("no daemon listening: exit 0, never throws, never prints the token", async () => {
    const url = await startDaemon(() => {})
    await new Promise<void>(r => server!.close(() => r()))
    server = undefined
    pointAt(url)
    await expect(runHook(["pre-compact"], { readStdin: async () => payload() })).resolves.toBe(0)
    expect(stdout).toEqual([])
    expect(stderr.length).toBeLessThanOrEqual(1)
    noSecret()
  })

  it("no daemon session id in the env: exit 0 without any request", async () => {
    pointAt(
      await startDaemon((_req, res) => {
        res.writeHead(200)
        res.end("{}")
      }),
    )
    delete process.env[SESSION_ENV]
    expect(await runHook(["pre-compact"], { readStdin: async () => payload() })).toBe(0)
    expect(seen).toEqual([])
    expect(stdout).toEqual([])
    expect(stderr).toEqual([])
  })

  it("garbage on stdin still exits 0", async () => {
    pointAt(
      await startDaemon((_req, res) => {
        res.writeHead(200)
        res.end("{}")
      }),
    )
    expect(await runHook(["pre-compact"], { readStdin: async () => "{not json" })).toBe(0)
    expect(stdout).toEqual([])
  })

  it("is listed among the known subcommands", async () => {
    expect(await runHook(["nope"])).toBe(2)
    expect(stderr.join("")).toContain("Known: inbox, pre-compact")
  })
})
