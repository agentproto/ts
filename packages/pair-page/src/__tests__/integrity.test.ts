/**
 * The Worker publishes the SHA-256 of the built pair-page bundle at
 * /.well-known/agentproto-pair-page.json (AIP-59 §5.9), so a careful user or
 * a monitor can check what a daemon's pair origin serves.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"
import { handleRequest, type EdgeEnv } from "../edge"

const MANIFEST_PATH = "/.well-known/agentproto-pair-page.json"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, "../..")
const dist = path.join(pkgRoot, "dist")
const FP = "ae5be03faa146dd70123456789abcdef"

async function listFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Recompute the hash exactly as scripts/build.mjs defines it. */
async function bundleHash(): Promise<string> {
  const manifestRel = MANIFEST_PATH.replace(/^\//, "")
  const files = (await listFiles(dist)).filter(f => f !== manifestRel).sort()
  const hash = createHash("sha256")
  for (const rel of files) {
    hash.update(rel, "utf8")
    hash.update("\0")
    hash.update(await readFile(path.join(dist, rel)))
  }
  return hash.digest("hex")
}

function assetsEnv(): EdgeEnv {
  return {
    PAIR_DOMAIN: "agentproto.cloud",
    ASSETS: {
      async fetch(input) {
        const url = new URL(input instanceof Request ? input.url : String(input))
        try {
          const body = await readFile(path.join(dist, url.pathname))
          return new Response(body)
        } catch {
          return new Response("missing", { status: 404 })
        }
      },
    },
  }
}

describe("pair-page release integrity manifest", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(pkgRoot, "scripts/build.mjs")], {
      cwd: pkgRoot,
      stdio: "pipe",
    })
  })

  it("serves the hash of the bundle this build produced", async () => {
    // The route is the release promise: 200 with the manifest on a current
    // build, 404 on a build that predates this route.
    const res = await handleRequest(
      new Request(`https://${FP}.agentproto.cloud${MANIFEST_PATH}`),
      assetsEnv(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")

    const raw = await readFile(path.join(dist, MANIFEST_PATH.replace(/^\//, "")), "utf8")
    const manifest = JSON.parse(raw) as {
      version: string
      sha256: string
      builtAt: string
      files: string[]
    }
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Number.isNaN(Date.parse(manifest.builtAt))).toBe(false)
    expect(manifest.files).toContain("index.html")
    expect(manifest.files).toContain("pair-sw.js")
    expect(manifest.files).not.toContain(MANIFEST_PATH.replace(/^\//, ""))
    expect(manifest.files).toEqual([...manifest.files].sort())
    expect(manifest.sha256).toBe(await bundleHash())
    expect(await res.json()).toEqual(manifest)

    // A monitor recomputes from the files the ORIGIN serves, not from disk:
    // fetch every listed path through the Worker and hash those bytes.
    const hash = createHash("sha256")
    for (const rel of manifest.files) {
      const fileRes = await handleRequest(
        new Request(`https://${FP}.agentproto.cloud/${rel}`),
        assetsEnv(),
      )
      expect(fileRes.status, rel).toBe(200)
      hash.update(rel, "utf8")
      hash.update("\0")
      hash.update(new Uint8Array(await fileRes.arrayBuffer()))
    }
    expect(hash.digest("hex")).toBe(manifest.sha256)
  })
})
