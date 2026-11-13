/**
 * `GET /approvals/:id/attachments` and `/attachments/:name`: the daemon serves
 * the files an approval's preview names, to the operator and to that
 * approval's link. Real `startHttpServer` + real `ApprovalsEngine`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import type { ApprovalRecord } from "../approvals/types.js"
import { approvalAttachmentDir } from "../approvals/telegram-attachments.js"
import { mintAppLinkSessionToken, resetAppLinkSigningKeyCacheForTests } from "../app-link-token.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const APP_ID = "@agentik/bureau"
const BEARER = "daemon-bearer"
const OWNER_TG = "4242"
const FORWARDED = { "x-forwarded-for": "203.0.113.7" }
const FORBIDDEN = { error: "approval_link_forbidden" }
const NAMES = ["cv.pdf", "cover.md", "capture.png", "page.html", "logo.svg", "data.bin"]

let dir: string
let data: string
let keyPath: string
let engine: ApprovalsEngine
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproto-approval-files-"))
  keyPath = join(dir, "app_link_hmac")
  data = join(dir, "appdata")
  await mkdir(join(data, "dossier"), { recursive: true })
  for (const n of NAMES) await writeFile(join(data, "dossier", n), `content of ${n}`)
  await writeFile(join(data, "escape.md"), "outside the dossier")
  await writeFile(join(data, "dossier", "unlisted.md"), "not listed")
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  errorSpy.mockRestore()
  engine?.dispose()
  resetAppLinkSigningKeyCacheForTests()
  await rm(dir, { recursive: true, force: true })
})

async function withServer(fn: (base: string) => Promise<void>, humanIds: readonly string[] = [OWNER_TG]) {
  engine = createApprovalsEngine({ homeDir: join(dir, "approvals"), sessionEvents: createSessionEventBus() })
  const registry = createSessionsRegistry({ persist: false, transcriptDir: join(dir, "sessions") })
  const port = await freePort()
  const opts: RuntimeHttpServerOptions = {
    port,
    auth: { mode: "bearer", token: BEARER },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: {
      async open() {},
      async appendTurn() {},
      async read() {
        return { meta: {} as never, turns: [] }
      },
      async list() {
        return []
      },
      pathFor: (id: string) => id,
    },
    events: createRuntimeEvents(),
    heartbeat: { start() {}, stop() {}, async fireNow() {} },
    sessions: registry,
    meta: { workspace: process.cwd(), registered: [] },
    approvals: engine,
    approvalsWebOrigins: [],
    appLinkKeyPath: keyPath,
    approvalsHumanTelegramIds: humanIds,
    approvalsAttachmentDir: (record: ApprovalRecord) =>
      record.appId ? approvalAttachmentDir(record.preview, data) : undefined,
  }
  const http = await startHttpServer(opts)
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
    registry.shutdown()
  }
}

function open(preview: unknown, appId: string | null = APP_ID): ApprovalRecord {
  return engine.request(
    { kind: "send", title: "t", preview, payload: {}, ...(appId ? { appId } : {}) },
    { operator: true },
  )
}

const allNames = [...NAMES, "missing.md", "../escape.md"]
const preview = () => ({ dossier: "dossier", attachments: allNames })
const operator = { authorization: `Bearer ${BEARER}` }
const link = (approvalId: string, tg: string = OWNER_TG) => ({
  ...FORWARDED,
  authorization: `Bearer ${mintAppLinkSessionToken({ appId: APP_ID, claims: { approvalId, telegramUserId: tg }, ttlMs: 60_000, keyPath }).token}`,
})
const file = (base: string, id: string, name: string, headers: Record<string, string> = operator) =>
  fetch(`${base}/approvals/${id}/attachments/${encodeURIComponent(name)}`, { headers })

describe("approval files: the list", () => {
  it("answers the contract shape, in preview order, each name once", async () => {
    await withServer(async base => {
      const a = open(preview())
      const res = await fetch(`${base}/approvals/${a.id}/attachments`, { headers: operator })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { attachments: Array<Record<string, unknown>>; problems: unknown[] }
      expect(body.attachments.map(x => x.name)).toEqual(NAMES)
      expect(body.attachments[0]).toEqual({
        name: "cv.pdf",
        size: "content of cv.pdf".length,
        mimeType: "application/pdf",
        viewer: "pdf",
        url: `/approvals/${a.id}/attachments/cv.pdf`,
      })
      expect(body.attachments.map(x => x.viewer)).toEqual(["pdf", "markdown", "image", "html", "text", "file"])
      expect(body.problems).toEqual([
        { name: "missing.md", reason: "missing" },
        { name: "../escape.md", reason: "outside-folder" },
      ])
    })
  })

  it("an approval without appId: every name is a no-folder problem, nothing is served", async () => {
    await withServer(async base => {
      const a = open(preview(), null)
      const body = (await (await fetch(`${base}/approvals/${a.id}/attachments`, { headers: operator })).json()) as {
        attachments: unknown[]
        problems: Array<{ reason: string }>
      }
      expect(body.attachments).toEqual([])
      expect(body.problems).toHaveLength(allNames.length)
      expect(body.problems.every(p => p.reason === "no-folder")).toBe(true)
      expect((await file(base, a.id, "cv.pdf")).status).toBe(404)
    })
  })

  it("an unknown approval is 404 approval_not_found", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/approvals/apr_nope/attachments`, { headers: operator })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: "approval_not_found" })
    })
  })

  it("caps at 10 names, the rest is a too-many problem", async () => {
    await withServer(async base => {
      const many = Array.from({ length: 12 }, (_, i) => `f${i}.txt`)
      for (const n of many) await writeFile(join(data, "dossier", n), "x")
      const a = open({ dossier: "dossier", attachments: many })
      const body = (await (await fetch(`${base}/approvals/${a.id}/attachments`, { headers: operator })).json()) as {
        attachments: unknown[]
        problems: Array<{ reason: string }>
      }
      expect(body.attachments).toHaveLength(10)
      expect(body.problems).toEqual([{ name: "2 more", reason: "too-many" }])
    })
  })

  it("a 26 MB file is too-large in the list and 413 on GET", async () => {
    await withServer(async base => {
      await truncate(join(data, "dossier", "big.bin"), 0).catch(() => writeFile(join(data, "dossier", "big.bin"), ""))
      await truncate(join(data, "dossier", "big.bin"), 26 * 1024 * 1024)
      const a = open({ dossier: "dossier", attachments: ["big.bin"] })
      const body = (await (await fetch(`${base}/approvals/${a.id}/attachments`, { headers: operator })).json()) as {
        attachments: unknown[]
        problems: unknown[]
      }
      expect(body.attachments).toEqual([])
      expect(body.problems).toEqual([{ name: "big.bin", reason: "too-large", size: 26 * 1024 * 1024 }])
      const res = await file(base, a.id, "big.bin")
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: "attachment_too_large" })
    })
  })
})

describe("approval files: the fallback past resolveAttachments' own limits", () => {
  it("a 60 MB file and an empty file still resolve through the contained fallback", async () => {
    await withServer(async base => {
      await writeFile(join(data, "dossier", "huge.bin"), "")
      await truncate(join(data, "dossier", "huge.bin"), 60 * 1024 * 1024)
      await writeFile(join(data, "dossier", "empty.txt"), "")
      const a = open({ dossier: "dossier", attachments: ["huge.bin", "empty.txt"] })
      const body = (await (await fetch(`${base}/approvals/${a.id}/attachments`, { headers: operator })).json()) as {
        attachments: Array<{ name: string; size: number }>
        problems: unknown[]
      }
      expect(body.attachments.map(x => [x.name, x.size])).toEqual([["empty.txt", 0]])
      expect(body.problems).toEqual([{ name: "huge.bin", reason: "too-large", size: 60 * 1024 * 1024 }])
      expect((await file(base, a.id, "huge.bin")).status).toBe(413)
      const empty = await file(base, a.id, "empty.txt")
      expect(empty.status).toBe(200)
      expect(await empty.text()).toBe("")
    })
  })
})

describe("approval files: one file", () => {
  it("serves the type table with the hardening headers", async () => {
    await withServer(async base => {
      const a = open(preview())
      const expected: Record<string, [string, string]> = {
        "cv.pdf": ["application/pdf", "inline"],
        "cover.md": ["text/plain; charset=utf-8", "inline"],
        "capture.png": ["image/png", "inline"],
        "page.html": ["text/plain; charset=utf-8", "inline"],
        "logo.svg": ["text/plain; charset=utf-8", "inline"],
        "data.bin": ["application/octet-stream", "attachment"],
      }
      for (const [name, [type, disposition]] of Object.entries(expected)) {
        const res = await file(base, a.id, name)
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toBe(type)
        expect(res.headers.get("x-content-type-options")).toBe("nosniff")
        expect(res.headers.get("cache-control")).toBe("private, no-store")
        expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
        expect(res.headers.get("content-disposition")).toBe(`${disposition}; filename*=UTF-8''${name}`)
        expect(res.headers.get("content-length")).toBe(String(`content of ${name}`.length))
        expect(await res.text()).toBe(`content of ${name}`)
      }
    })
  })

  it("a file in the folder that the preview does not list is 404 attachment_not_found", async () => {
    await withServer(async base => {
      const a = open(preview())
      const res = await file(base, a.id, "unlisted.md")
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "attachment_not_found" })
      expect((await file(base, a.id, "../escape.md")).status).toBe(404)
    })
  })

  it("a symlink pointing outside the folder is never served", async () => {
    await withServer(async base => {
      await symlink(join(data, "escape.md"), join(dir, "unused")).catch(() => {})
      await symlink(join(data, "escape.md"), join(data, "dossier", "link.md"))
      const a = open({ dossier: "dossier", attachments: ["link.md"] })
      const body = (await (await fetch(`${base}/approvals/${a.id}/attachments`, { headers: operator })).json()) as {
        attachments: unknown[]
        problems: unknown[]
      }
      expect(body.attachments).toEqual([])
      expect(body.problems).toEqual([{ name: "link.md", reason: "outside-folder" }])
      expect((await file(base, a.id, "link.md")).status).toBe(404)
    })
  })

  it("a name with a slash arrives as %2F and decodes once", async () => {
    await withServer(async base => {
      await mkdir(join(data, "dossier", "sub"))
      await writeFile(join(data, "dossier", "sub", "n.txt"), "nested")
      const a = open({ dossier: "dossier", attachments: ["sub/n.txt"] })
      const res = await file(base, a.id, "sub/n.txt")
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("nested")
    })
  })
})

describe("approval files: who may read", () => {
  it("the right link reads the list and a file; the operator too", async () => {
    await withServer(async base => {
      const a = open(preview())
      const list = await fetch(`${base}/approvals/${a.id}/attachments`, { headers: link(a.id) })
      expect(list.status).toBe(200)
      expect((await file(base, a.id, "cv.pdf", link(a.id))).status).toBe(200)
      expect((await file(base, a.id, "cv.pdf")).status).toBe(200)
      expect(errorSpy.mock.calls.some(c => String(c[0]).startsWith("approval-link: files allowed"))).toBe(true)
    })
  })

  it("a link for approval A asking for B's files is 403 approval_link_forbidden", async () => {
    await withServer(async base => {
      const a = open(preview())
      const b = open(preview())
      for (const url of [`${base}/approvals/${b.id}/attachments`, `${base}/approvals/${b.id}/attachments/cv.pdf`]) {
        const res = await fetch(url, { headers: link(a.id) })
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual(FORBIDDEN)
      }
    })
  })

  it("a verified user not in humanTelegramIds is 403", async () => {
    await withServer(async base => {
      const a = open(preview())
      const res = await fetch(`${base}/approvals/${a.id}/attachments`, { headers: link(a.id, "999") })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual(FORBIDDEN)
    })
  })

  it("no credential over the tunnel is refused", async () => {
    await withServer(async base => {
      const a = open(preview())
      const res = await fetch(`${base}/approvals/${a.id}/attachments`, { headers: FORWARDED })
      expect(res.status).not.toBe(200)
    })
  })
})
