import { createServer, type Server } from "node:http"
import { mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type ExitCode, type Io, main } from "../index"

const here = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = resolve(here, "../..")
export const STORES = join(PACKAGE_ROOT, ".test-stores")
export const FAKE = join(here, "fixtures/fake-connector.mjs")
export const KEYED = join(here, "fixtures/keyed-connector.mjs")

let counter = 0
const created: string[] = []
/** A fresh directory under the package, never in /tmp. */
export function workdir(name: string): string {
  const dir = join(STORES, `${name}-${process.pid}-${counter++}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  created.push(dir)
  return dir
}

/** Remove what this test file created (files run in parallel and share `.test-stores/`). */
export function cleanStores(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  try {
    rmdirSync(STORES)
  } catch {
    // other files still use it
  }
}

export interface Result {
  code: ExitCode
  stdout: string
  stderr: string
  json<T = unknown>(): T
}

export async function cli(args: string[], opts: { cwd: string; env?: Record<string, string | undefined>; signal?: AbortSignal }): Promise<Result> {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    stdout: { write: (s) => void (stdout += s) },
    stderr: { write: (s) => void (stderr += s) },
    env: { ...opts.env },
    cwd: opts.cwd,
    signal: opts.signal,
  }
  const code = await main(args, io)
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T }
}

export interface FakeServer {
  base: string
  hits: string[]
  onRequest?: (path: string, n: number) => void
  close(): Promise<void>
}

/** Local 127.0.0.1 server: `/q/<name>` answers two posts, `/q/missing` is a 404. */
export async function startServer(): Promise<FakeServer> {
  const state: FakeServer = { base: "", hits: [], close: async () => {} }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    state.hits.push(url.pathname)
    state.onRequest?.(url.pathname, state.hits.length)
    const name = decodeURIComponent(url.pathname.replace(/^\/q\//, ""))
    if (name === "missing") {
      res.writeHead(404, { "content-type": "text/plain" }).end("nothing here")
      return
    }
    const posts = [1, 2].map((n) => ({
      id: `${name}-${n}`,
      author: `user${n}`,
      views: n * 100,
      text: `Post ${n} about ${name}, with "quotes"\nand a second line`,
    }))
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ posts }))
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")
  state.base = `http://127.0.0.1:${addr.port}`
  state.close = () => new Promise<void>((r) => server.close(() => r()))
  return state
}

export function writeRecipe(dir: string, base: string, queries: string[], extra = ""): string {
  const file = join(dir, "recipe.yaml")
  const qs = queries.map((q) => `      - { text: ${q}, subject: topic }`).join("\n")
  writeFileSync(
    file,
    `name: test-recipe
connectors:
  - ${FAKE}
sources:
  - connector: fake
    options: { base: "${base}" }
    queries:
${qs}
${extra}`,
  )
  return file
}

/** Every file below a directory, sorted, with sizes: a cheap "nothing changed" fingerprint. */
export function listing(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p.slice(dir.length))
    }
  }
  walk(dir)
  return out.sort()
}

/** RFC 4180 parser, enough to read back what `export --format csv` writes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      row.push(cell)
      cell = ""
    } else if (c === "\n") {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += c
  }
  return rows
}
