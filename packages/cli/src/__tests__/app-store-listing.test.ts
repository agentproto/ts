/**
 * Store listing (APP.md `store:` -> app-catalog/v1 listing fields): the pure
 * reader and limit checks (app-store-listing.ts), `app pack --release
 * --entry` carrying the listing and laying out its media, and `catalog
 * verify` re-checking a published listing, including `--local-media`.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  imageSize,
  listingIssues,
  readStoreListing,
  sniffImageFormat,
  StoreListingError,
} from "../app-store-listing.js"
import { runAppPack } from "../commands/app.js"
import { runCatalog } from "../commands/catalog.js"

const tmpRoots: string[] = []

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
  vi.restoreAllMocks()
})

async function mktmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "store-listing-test-"))
  tmpRoots.push(dir)
  return dir
}

/** A png header (signature + IHDR) of the given size, padded to `bytes`. */
function png(width: number, height: number, bytes = 64): Buffer {
  const b = Buffer.alloc(Math.max(bytes, 33))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write("IHDR", 12, "ascii")
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>\n')

const STORE_BLOCK =
  `store:\n` +
  `  tagline: Chat with any agentproto session.\n` +
  `  categories: [chat, sessions]\n` +
  `  publisher: Agentik\n` +
  `  homepage: https://agentproto.sh/apps/shop-app\n` +
  `  repository: https://github.com/acme/shop-app\n` +
  `  icon: store/icon.svg\n` +
  `  listing: store/LISTING.md\n` +
  `  screenshots:\n` +
  `    - path: store/screenshots/thread.png\n` +
  `      alt: A session replayed as a chat thread\n` +
  `    - url: https://cdn.example/remote.png\n` +
  `      alt: A remote capture\n` +
  `      width: 640\n`

async function appWithStore(root: string, store = STORE_BLOCK): Promise<string> {
  const appDir = join(root, "shop-app")
  await mkdir(join(appDir, ".agentproto", "ui"), { recursive: true })
  await mkdir(join(appDir, "store", "screenshots"), { recursive: true })
  await writeFile(
    join(appDir, ".agentproto", "APP.md"),
    `---\nschema: app/v1\nid: "@acme/shop-app"\nname: Shop App\nversion: 1.2.0\ndescription: A shop\nagents: []\nworkflows: []\n` +
      `ui:\n  path: .agentproto/ui/index.html\n${store}---\n# Shop\n`,
  )
  await writeFile(join(appDir, ".agentproto", "ui", "index.html"), "<!doctype html><html></html>\n")
  await writeFile(join(appDir, "store", "LISTING.md"), "# Shop App\n\nBuy **things**.\n")
  await writeFile(join(appDir, "store", "icon.svg"), SVG)
  await writeFile(join(appDir, "store", "screenshots", "thread.png"), png(1280, 800))
  return appDir
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true))
  vi.spyOn(process.stderr, "write").mockImplementation((c) => (err.push(String(c)), true))
  try {
    return { code: await fn(), out: out.join(""), err: err.join("") }
  } finally {
    vi.restoreAllMocks()
  }
}

describe("image sniffing", () => {
  it("detects png/jpeg/webp/svg from bytes and reads png/jpeg sizes", () => {
    expect(sniffImageFormat(png(10, 20))).toBe("png")
    expect(imageSize(png(10, 20))).toEqual({ width: 10, height: 20 })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03])
    expect(sniffImageFormat(jpeg)).toBe("jpeg")
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 })
    expect(sniffImageFormat(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1"))).toBe("webp")
    expect(sniffImageFormat(SVG)).toBe("svg")
    expect(sniffImageFormat(Buffer.from("GIF89a"))).toBeUndefined()
  })
})

describe("readStoreListing", () => {
  it("maps the store block to listing fields and local media", async () => {
    const appDir = await appWithStore(await mktmp())
    const listing = await readStoreListing(appDir, (await import("gray-matter")).default(
      await readFile(join(appDir, ".agentproto", "APP.md"), "utf8"),
    ).data, { mediaBaseUrl: "https://media.example/m/" })
    expect(listing?.fields).toEqual({
      tagline: "Chat with any agentproto session.",
      publisher: "Agentik",
      homepage: "https://agentproto.sh/apps/shop-app",
      repository: "https://github.com/acme/shop-app",
      categories: ["chat", "sessions"],
      longDescription: "# Shop App\n\nBuy **things**.",
      icon: "https://media.example/m/icon.svg",
      screenshots: [
        { url: "https://media.example/m/thread.png", alt: "A session replayed as a chat thread", width: 1280, height: 800 },
        { url: "https://cdn.example/remote.png", alt: "A remote capture", width: 640 },
      ],
    })
    expect(listing?.media.map((m) => m.name)).toEqual(["icon.svg", "thread.png"])
  })

  it("no store block = no listing", async () => {
    expect(await readStoreListing("/nowhere", {}, { mediaBaseUrl: "https://x" })).toBeUndefined()
  })

  it.each([
    ["a screenshot without alt", STORE_BLOCK.replace("      alt: A session replayed as a chat thread\n", ""), "alt is required"],
    ["a path outside the app", STORE_BLOCK.replace("store/screenshots/thread.png", "../../etc/passwd"), "points outside the app"],
    ["an http homepage", STORE_BLOCK.replace("https://agentproto.sh/apps/shop-app", "http://agentproto.sh"), "homepage must be an https URL"],
    ["a bad category", STORE_BLOCK.replace("[chat, sessions]", "[Chat Apps]"), "category 'Chat Apps'"],
    ["a gif screenshot", STORE_BLOCK.replace("thread.png\n", "anim.gif\n"), "cannot read"],
  ])("rejects %s", async (_label, store, message) => {
    const appDir = await appWithStore(await mktmp(), store)
    const front = (await import("gray-matter")).default(await readFile(join(appDir, ".agentproto", "APP.md"), "utf8")).data
    await expect(readStoreListing(appDir, front, { mediaBaseUrl: "https://m" })).rejects.toThrow(StoreListingError)
    await expect(readStoreListing(appDir, front, { mediaBaseUrl: "https://m" })).rejects.toThrow(message)
  })

  it("rejects an oversized or non-image screenshot file", async () => {
    const root = await mktmp()
    const appDir = await appWithStore(root)
    const front = (await import("gray-matter")).default(await readFile(join(appDir, ".agentproto", "APP.md"), "utf8")).data
    await writeFile(join(appDir, "store", "screenshots", "thread.png"), png(10, 10, 1_000_001))
    await expect(readStoreListing(appDir, front, { mediaBaseUrl: "https://m" })).rejects.toThrow("over the 1000000 byte cap")
    await writeFile(join(appDir, "store", "screenshots", "thread.png"), "not an image")
    await expect(readStoreListing(appDir, front, { mediaBaseUrl: "https://m" })).rejects.toThrow("must be png/jpeg/webp")
  })

  it("listingIssues caps counts and lengths", () => {
    const shot = { url: "https://x/a.png", alt: "a" }
    expect(listingIssues({ screenshots: Array(9).fill(shot) })).toContain("at most 8 screenshots (got 9)")
    expect(listingIssues({ tagline: "x".repeat(121) })[0]).toMatch(/tagline must be 1 to 120/)
    expect(listingIssues({ categories: ["a", "b", "c", "d", "e", "f"] })[0]).toMatch(/at most 5 categories/)
    expect(listingIssues({ longDescription: "x".repeat(20_001) })[0]).toMatch(/longDescription exceeds/)
  })
})

describe("app pack --release --entry with a store listing", () => {
  it("carries the listing in the entry, lays out media/<appId>/<version>/, keeps store/ out of the bundle", async () => {
    const root = await mktmp()
    const appDir = await appWithStore(root)
    const outDir = join(root, "dist")
    const res = await capture(() => runAppPack([appDir, "--release", "--entry", "--out", outDir, "--json"]))
    expect(res.code, res.err).toBe(0)
    const { entry, media, bundle } = JSON.parse(res.out) as {
      entry: Record<string, unknown>
      media: string[]
      bundle: string
    }
    const base = "https://raw.githubusercontent.com/agentproto/apps/main/media/@acme/shop-app/1.2.0"
    expect(entry.tagline).toBe("Chat with any agentproto session.")
    expect(entry.icon).toBe(`${base}/icon.svg`)
    expect((entry.screenshots as Array<{ url: string }>)[0]!.url).toBe(`${base}/thread.png`)
    expect(entry.longDescription).toContain("Buy **things**.")
    expect(media).toEqual([
      join(outDir, "media", "@acme", "shop-app", "1.2.0", "icon.svg"),
      join(outDir, "media", "@acme", "shop-app", "1.2.0", "thread.png"),
    ])
    for (const m of media) expect(existsSync(m)).toBe(true)

    const { unpackApp } = await import("@agentproto/app-kit")
    const { manifest } = await unpackApp({ file: bundle, dest: join(root, "restored") })
    expect(manifest.files.some((f) => f.startsWith("store/"))).toBe(false)
  })

  it("--media-base-url relocates local media; an invalid listing fails before packing", async () => {
    const root = await mktmp()
    const appDir = await appWithStore(root)
    const outDir = join(root, "dist")
    const ok = await capture(() =>
      runAppPack([appDir, "--release", "--entry", "--out", outDir, "--json", "--media-base-url", "https://cdn.acme.dev/shop/1.2.0"]),
    )
    expect(JSON.parse(ok.out).entry.icon).toBe("https://cdn.acme.dev/shop/1.2.0/icon.svg")

    const bad = await appWithStore(await mktmp(), STORE_BLOCK.replace("  tagline: Chat with any agentproto session.\n", `  tagline: ${"x".repeat(130)}\n`))
    const badOut = join(root, "bad-dist")
    const res = await capture(() => runAppPack([bad, "--release", "--entry", "--out", badOut]))
    expect(res.code).toBe(1)
    expect(res.err).toContain("invalid store listing")
    expect(existsSync(badOut)).toBe(false)
  })
})

describe("catalog verify: store listing", () => {
  async function packed(root: string): Promise<{ entryFile: string; bundle: string; outDir: string; appId: string }> {
    const appDir = await appWithStore(root, STORE_BLOCK.replace(/    - url: https:\/\/cdn\.example\/remote\.png\n      alt: A remote capture\n      width: 640\n/, ""))
    const outDir = join(root, "dist")
    const res = await capture(() => runAppPack([appDir, "--release", "--entry", "--out", outDir, "--json"]))
    const parsed = JSON.parse(res.out) as { entryFile: string; bundle: string; entry: { appId: string } }
    return { entryFile: parsed.entryFile, bundle: parsed.bundle, outDir, appId: parsed.entry.appId }
  }

  it("passes with --local-media mapping the catalog repo prefix to the PR checkout", async () => {
    const root = await mktmp()
    const { entryFile, bundle, outDir, appId } = await packed(root)
    const res = await capture(() =>
      runCatalog([
        "verify", entryFile, "--json",
        "--offline-file", `${appId}=${bundle}`,
        "--local-media", `https://raw.githubusercontent.com/agentproto/apps/main/=${outDir}`,
      ]),
    )
    const report = JSON.parse(res.out) as { ok: boolean; entries: Array<{ checks: Array<{ name: string; ok: boolean; detail?: string }> }> }
    const checks = report.entries[0]!.checks
    // The whole entry verifies, app-validate included: a `store:` block in
    // the shipped APP.md is accepted by the loader.
    expect(checks.filter((c) => !c.ok)).toEqual([])
    expect(report.ok).toBe(true)
    expect(checks.find((c) => c.name === "listing")?.ok).toBe(true)
    expect(checks.find((c) => c.name === "media")).toMatchObject({ ok: true, detail: "2 file(s) checked" })
  })

  it("fails on a missing alt and on media that are not where the entry says", async () => {
    const root = await mktmp()
    const { entryFile, bundle, appId } = await packed(root)
    const entry = JSON.parse(await readFile(entryFile, "utf8"))
    entry.screenshots[0].alt = " "
    await writeFile(entryFile, JSON.stringify(entry))
    const emptyDir = join(root, "empty")
    await mkdir(emptyDir)
    const res = await capture(() =>
      runCatalog([
        "verify", entryFile, "--json",
        "--offline-file", `${appId}=${bundle}`,
        "--local-media", `https://raw.githubusercontent.com/agentproto/apps/main/=${emptyDir}`,
      ]),
    )
    expect(res.code).toBe(1)
    const checks = (JSON.parse(res.out) as { entries: Array<{ checks: Array<{ name: string; ok: boolean; detail?: string }> }> }).entries[0]!.checks
    expect(checks.find((c) => c.name === "listing")).toMatchObject({ ok: false })
    expect(checks.find((c) => c.name === "listing")?.detail).toContain("alt is required")
    expect(checks.find((c) => c.name === "media")?.ok).toBe(false)
  })
})
