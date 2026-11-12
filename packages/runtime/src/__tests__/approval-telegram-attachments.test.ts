/**
 * Where an approval's `preview.attachments` are looked up: a folder inside the
 * data root of the app that opened it, never outside.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { approvalAttachmentDir, readAttachmentNames, resolveAttachments } from "../approvals/telegram-attachments.js"

describe("approval attachments", () => {
  let base: string
  let root: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "approval-att-")))
    root = join(base, "data")
    mkdirSync(join(root, "kits", "acme", "backend"), { recursive: true })
    mkdirSync(join(base, "elsewhere"))
    writeFileSync(join(base, "elsewhere", "secret.txt"), "secret")
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  describe("approvalAttachmentDir", () => {
    it("finds a dossier one level under the data root, as the job kit lays it out", async () => {
      expect(await approvalAttachmentDir({ dossier: "acme/backend" }, root)).toBe(join(root, "kits", "acme", "backend"))
    })

    it("prefers a dossier that is a direct child of the data root", async () => {
      mkdirSync(join(root, "acme", "backend"), { recursive: true })
      expect(await approvalAttachmentDir({ dossier: "acme/backend" }, root)).toBe(join(root, "acme", "backend"))
    })

    it("gives up when two folders match the dossier", async () => {
      mkdirSync(join(root, "archive", "acme", "backend"), { recursive: true })
      expect(await approvalAttachmentDir({ dossier: "acme/backend" }, root)).toBeUndefined()
    })

    it("takes attachmentsDir literally, with no lookup", async () => {
      expect(await approvalAttachmentDir({ attachmentsDir: "kits/acme/backend", dossier: "x" }, root)).toBe(
        join(root, "kits", "acme", "backend"),
      )
      expect(await approvalAttachmentDir({ attachmentsDir: "acme/backend" }, root)).toBeUndefined()
    })

    it("uses the data root itself when the preview names no folder", async () => {
      expect(await approvalAttachmentDir({ summary: "x" }, root)).toBe(root)
    })

    it("never returns a folder outside the data root", async () => {
      symlinkSync(join(base, "elsewhere"), join(root, "out"))
      expect(await approvalAttachmentDir({ dossier: "../elsewhere" }, root)).toBeUndefined()
      expect(await approvalAttachmentDir({ dossier: join(base, "elsewhere") }, root)).toBeUndefined()
      expect(await approvalAttachmentDir({ dossier: "out" }, root)).toBeUndefined()
      expect(await approvalAttachmentDir({ attachmentsDir: "out" }, root)).toBeUndefined()
      expect(await approvalAttachmentDir({ dossier: "acme/backend" }, join(base, "missing"))).toBeUndefined()
    })
  })

  it("resolveAttachments puts every name in exactly one list", async () => {
    const dir = join(root, "kits", "acme", "backend")
    writeFileSync(join(dir, "cv.pdf"), "pdf")
    // A 1000 x 9000 PNG header: too tall to be readable as a Telegram photo.
    const tall = Buffer.alloc(24)
    tall.writeUInt32BE(0x89504e47, 0)
    tall.write("IHDR", 12, "latin1")
    tall.writeUInt32BE(1000, 16)
    tall.writeUInt32BE(9000, 20)
    writeFileSync(join(dir, "full-page.png"), tall)
    writeFileSync(join(dir, "small.jpg"), "jpg")
    const { files, problems } = await resolveAttachments(
      ["cv.pdf", "full-page.png", "small.jpg", "../../../../elsewhere/secret.txt", "nope.pdf"],
      dir,
    )
    expect(files.map(f => [f.name, f.kind])).toEqual([
      ["cv.pdf", "document"],
      ["full-page.png", "document"],
      ["small.jpg", "photo"],
    ])
    expect(files.every(f => f.path.startsWith(dir))).toBe(true)
    expect(problems.map(p => p.name)).toEqual(["../../../../elsewhere/secret.txt", "nope.pdf"])
  })

  it("readAttachmentNames caps the list at 10 and counts the rest", () => {
    const names = Array.from({ length: 13 }, (_, i) => `f${i}.pdf`)
    const read = readAttachmentNames({ attachments: [...names, "f0.pdf"] })
    expect(read.claimed).toBe(true)
    expect(read.names).toEqual(names.slice(0, 10))
    expect(read.problems).toEqual([{ name: "3 more", reason: "over the limit of 10 attachments per card" }])
    expect(readAttachmentNames({ attachments: [{ sizeBytes: 3 }] }).claimed).toBe(false)
    expect(readAttachmentNames({ attachments: [{ filename: "a.pdf", mimeType: "application/pdf" }] }).names).toEqual(["a.pdf"])
    // A mail preview's { fileName, sizeBytes } stays with the card's own rendering.
    expect(readAttachmentNames({ kind: "mail", attachments: [{ fileName: "a", sizeBytes: 3 }] }).claimed).toBe(false)
    expect(readAttachmentNames("text").claimed).toBe(false)
  })
})
