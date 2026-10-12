import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import {
  ENTRY_GRAPH_HOOK_SOURCE,
  ENTRY_GRAPH_VERSION_PARAM,
  appendEntryGraphVersion,
  entryGraphResolveSync,
  entryGraphVersion,
  installEntryGraphHook,
} from "../entry-graph.js"

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "entry-graph-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("entryGraphVersion", () => {
  it("is stable for an untouched graph and changes with the content of any reachable file", async () => {
    const dir = tmp()
    mkdirSync(join(dir, "wf"))
    mkdirSync(join(dir, "shared"))
    const entry = join(dir, "wf", "entry.mjs")
    writeFileSync(entry, 'import "./a.mjs"; import "../shared/s.mjs"')
    writeFileSync(join(dir, "wf", "a.mjs"), 'import "./b.mjs"')
    writeFileSync(join(dir, "wf", "b.mjs"), "export const b = 1")
    writeFileSync(join(dir, "shared", "s.mjs"), 'export * from "./t.mjs"')
    writeFileSync(join(dir, "shared", "t.mjs"), "export const t = 1")
    writeFileSync(join(dir, "outside.mjs"), "export const o = 1")
    const v0 = await entryGraphVersion(entry)
    expect(v0).toMatch(/^[0-9a-f]{16}$/)
    expect(await entryGraphVersion(entry)).toBe(v0)

    writeFileSync(join(dir, "outside.mjs"), "export const o = 2")
    expect(await entryGraphVersion(entry)).toBe(v0)

    const seen = new Set([v0])
    for (const [file, content] of [
      ["wf/b.mjs", "export const b = 2"],
      ["shared/t.mjs", "export const t = 2"],
      ["shared/s.mjs", 'export * from "./t.mjs"; export const s = 1'],
    ] as const) {
      writeFileSync(join(dir, file), content)
      const v = await entryGraphVersion(entry)
      expect(seen.has(v)).toBe(false)
      seen.add(v)
    }
  })

  it("ignores dotfiles and node_modules, and follows imports past the directory-scan depth", async () => {
    const dir = tmp()
    const entry = join(dir, "entry.mjs")
    mkdirSync(join(dir, "node_modules"))
    mkdirSync(join(dir, "a/b/c/d"), { recursive: true })
    writeFileSync(entry, 'import "./a/b/c/d/deep.mjs"')
    writeFileSync(join(dir, "a/b/c/d/deep.mjs"), "export const d = 1")
    writeFileSync(join(dir, "node_modules", "x.mjs"), "1")
    writeFileSync(join(dir, ".hidden.mjs"), "1")
    const v0 = await entryGraphVersion(entry)
    writeFileSync(join(dir, "node_modules", "x.mjs"), "2")
    writeFileSync(join(dir, ".hidden.mjs"), "2")
    expect(await entryGraphVersion(entry)).toBe(v0)
    writeFileSync(join(dir, "a/b/c/d/deep.mjs"), "export const d = 2")
    expect(await entryGraphVersion(entry)).not.toBe(v0)
  })

  it("changes when a missing import target appears, and survives import cycles", async () => {
    const dir = tmp()
    const entry = join(dir, "entry.mjs")
    writeFileSync(entry, 'import "./later.mjs"')
    const missing = await entryGraphVersion(entry)
    writeFileSync(join(dir, "later.mjs"), 'import "./entry.mjs"')
    expect(await entryGraphVersion(entry)).not.toBe(missing)
  })

  it("is empty for an unreadable entry", async () => {
    expect(await entryGraphVersion(join(tmp(), "nope", "entry.mjs"))).toBe("")
  })
})

describe("appendEntryGraphVersion (pure rewrite)", () => {
  const file = (href: string) => ({ url: href })
  const versionedParent = "file:///wf/entry.mjs?agentproto_v=abc"

  it("appends the version to a relative file import and preserves other queries", () => {
    const out = appendEntryGraphVersion(
      "./dep.mjs?raw",
      { parentURL: versionedParent },
      file("file:///wf/dep.mjs?raw"),
    )
    const url = new URL(out.url)
    expect(url.searchParams.get("raw")).toBe("")
    expect(url.searchParams.get(ENTRY_GRAPH_VERSION_PARAM)).toBe("abc")
  })

  it("passes bare specifiers, non-file URLs, node_modules paths, and unversioned parents through", () => {
    const ctx = { parentURL: versionedParent }
    expect(appendEntryGraphVersion("node:path", ctx, file("node:path")).url).toBe("node:path")
    expect(appendEntryGraphVersion("data:text/javascript,1", ctx, file("data:text/javascript,1")).url).toBe(
      "data:text/javascript,1",
    )
    expect(
      appendEntryGraphVersion("./x.mjs", ctx, file("file:///wf/node_modules/x/index.mjs")).url,
    ).toBe("file:///wf/node_modules/x/index.mjs")
    expect(
      appendEntryGraphVersion("./dep.mjs", { parentURL: "file:///wf/entry.mjs" }, file("file:///wf/dep.mjs")).url,
    ).toBe("file:///wf/dep.mjs")
    expect(appendEntryGraphVersion("./dep.mjs", {}, file("file:///wf/dep.mjs")).url).toBe("file:///wf/dep.mjs")
  })
})

describe("installEntryGraphHook (registration branch selection)", () => {
  it("prefers the synchronous in-thread registrar and never touches the async one", () => {
    const seen: unknown[] = []
    const ok = installEntryGraphHook(
      (options: { resolve: unknown }) => seen.push(options),
      () => {
        throw new Error("async register must not be reached")
      },
    )
    expect(ok).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it("falls back to the data-URL async registration when registerHooks is absent (Node < 22.15)", () => {
    const registered: string[] = []
    const ok = installEntryGraphHook(undefined, specifier => registered.push(specifier))
    expect(ok).toBe(true)
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatch(/^data:text\/javascript,/)
    // the fallback source is the async wrapper over the shared pure rewrite
    const source = decodeURIComponent(registered[0]!.slice("data:text/javascript,".length))
    expect(source).toContain("await nextResolve")
    expect(source).toContain(ENTRY_GRAPH_VERSION_PARAM)
  })

  it("falls back when the synchronous registrar throws, and reports false only when both fail", () => {
    const registered: string[] = []
    expect(
      installEntryGraphHook(
        () => {
          throw new Error("nope")
        },
        specifier => registered.push(specifier),
      ),
    ).toBe(true)
    expect(registered).toHaveLength(1)
    expect(
      installEntryGraphHook(undefined, () => {
        throw new Error("nope either")
      }),
    ).toBe(false)
  })
})

/** Both ways `registerEntryGraphHook` can install the SAME resolve logic in a
 *  real process: the synchronous in-thread hook (Node >= 22.15) and the
 *  off-thread `module.register()` fallback every supported Node has. The sync
 *  driver skips itself on a runtime without `registerHooks` — the fallback
 *  driver always runs, since that path exists on the whole engines range. */
const HOOK_REGISTRATIONS: ReadonlyArray<{ name: string; prelude: string }> = [
  {
    name: "registerHooks (synchronous, in-thread)",
    prelude: `
      const m = await import("node:module")
      if (typeof m.registerHooks !== "function") { console.log(JSON.stringify({ skipped: true })); process.exit(0) }
      const ENTRY_GRAPH_VERSION_PARAM = ${JSON.stringify(ENTRY_GRAPH_VERSION_PARAM)}
      const appendEntryGraphVersion = ${String(appendEntryGraphVersion)}
      m.registerHooks({ resolve: ${String(entryGraphResolveSync)} })
    `,
  },
  {
    name: "module.register() fallback (async, off-thread)",
    prelude: `
      const m = await import("node:module")
      m.register("data:text/javascript," + encodeURIComponent(${JSON.stringify(ENTRY_GRAPH_HOOK_SOURCE)}))
    `,
  },
]

function runChild<T = Record<string, unknown>>(script: string): T {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
  return JSON.parse(out.trim().split("\n").pop()!) as T
}

describe.each(HOOK_REGISTRATIONS)("entry-graph resolve hook — $name (real node process)", ({ prelude }) => {
  /** Imports `entry.mjs` twice at two versions, editing a relative import
   *  between; prints what each import saw. */
  const driver = (dir: string) => `
    import { writeFileSync } from "node:fs"
    import { pathToFileURL } from "node:url"
    ${prelude}
    const entry = pathToFileURL(${JSON.stringify(join(dir, "entry.mjs"))})
    const load = async v => {
      const u = new URL(entry); if (v !== undefined) u.searchParams.set(${JSON.stringify(ENTRY_GRAPH_VERSION_PARAM)}, v)
      return (await import(u.href)).default
    }
    const first = await load("1")
    writeFileSync(${JSON.stringify(join(dir, "dep.mjs"))}, 'import { deep } from "./deep.mjs"; export const value = "new:" + deep')
    writeFileSync(${JSON.stringify(join(dir, "deep.mjs"))}, 'export const deep = "deep-new"')
    const sameVersion = await load("1")
    const bumped = await load("2")
    console.log(JSON.stringify({ first, sameVersion, bumped }))
  `

  it("re-reads relative imports (and theirs) when the version changes, serves the cache when it does not", () => {
    const dir = tmp()
    writeFileSync(join(dir, "entry.mjs"), 'import { value } from "./dep.mjs"\nexport default value')
    writeFileSync(join(dir, "dep.mjs"), 'import { deep } from "./deep.mjs"; export const value = "old:" + deep')
    writeFileSync(join(dir, "deep.mjs"), 'export const deep = "deep-old"')
    const out = runChild(driver(dir))
    if (out.skipped) return
    expect(out).toEqual({
      first: "old:deep-old",
      sameVersion: "old:deep-old",
      bumped: "new:deep-new",
    })
  })

  it("never versions bare specifiers (shared library singletons stay single)", () => {
    const dir = tmp()
    writeFileSync(join(dir, "entry.mjs"), 'import { sep } from "node:path"\nimport os from "node:os"\nexport default [sep, typeof os.cpus]')
    const script = `
      import { pathToFileURL } from "node:url"
      ${prelude}
      const u = pathToFileURL(${JSON.stringify(join(dir, "entry.mjs"))}); u.searchParams.set("${ENTRY_GRAPH_VERSION_PARAM}", "7")
      console.log(JSON.stringify((await import(u.href)).default))
    `
    const out = runChild(script)
    if (out.skipped) return
    expect(out).toEqual(["/", "function"])
  })

  it("appends the version to relative imports without dropping an existing query string", () => {
    const dir = tmp()
    writeFileSync(
      join(dir, "entry.mjs"),
      'import { url } from "./dep.mjs?raw"\nexport default url',
    )
    writeFileSync(join(dir, "dep.mjs"), "export const url = import.meta.url")
    const script = `
      import { pathToFileURL } from "node:url"
      ${prelude}
      const u = pathToFileURL(${JSON.stringify(join(dir, "entry.mjs"))}); u.searchParams.set("${ENTRY_GRAPH_VERSION_PARAM}", "9")
      console.log(JSON.stringify((await import(u.href)).default))
    `
    const out = runChild<string | { skipped: true }>(script)
    if (typeof out !== "string") return
    const depUrl = new URL(out)
    expect(depUrl.searchParams.get("raw")).toBe("")
    expect(depUrl.searchParams.get(ENTRY_GRAPH_VERSION_PARAM)).toBe("9")
  })
})
