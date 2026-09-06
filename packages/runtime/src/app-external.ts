/**
 * Read-only external filesystem access for installed apps — a third data
 * plane alongside `app_data_*` (app-data.ts, sandboxed under an app's own
 * `dir`) and the generic fs-tools (fs-tools.ts, anchored to the daemon-wide
 * `--workspace` root). Neither of those covers a real host folder outside
 * the daemon's sandbox that a user explicitly opted an app into reading
 * (e.g. job-application-kit's `~/Downloads/applications`) — this plane
 * exists for exactly that case, and only for that case.
 *
 * Tools:
 *   app_external_list  list directory entries (name/isDirectory/size) under
 *                       a granted root + app-relative path
 *   app_external_read  read a text-ish file (allowlisted extensions,
 *                       size-capped) under a granted root
 *
 * The opt-in boundary is `InstalledApp.externalReadRoots` — normalized,
 * validated-to-exist absolute paths set once at install time
 * (`performInstall` in app-tools.ts). A caller's `root` argument must be an
 * EXACT string match to one of those entries; there is no prefix/fuzzy
 * matching and no way to widen access from inside a tool call.
 *
 * Hard requirement: this plane is READ-ONLY. There is no write/rename/
 * delete tool for these roots anywhere in the daemon, and there must never
 * be one — the data behind an external root is a real user's real files
 * (GDPR-sensitive), not app-owned sandbox state. Binary files (PDFs,
 * images, …) are never read into a tool's JSON response either — only an
 * allowlist of text-ish extensions is readable here; anything else must go
 * through `GET /apps/:appId/external-blob` (http-server.ts), which streams
 * bytes over HTTP instead of stuffing them into an LLM's context (the exact
 * failure mode that caused a context-exhaustion bug in a sibling app).
 */

import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { extname, isAbsolute, join, resolve, sep } from "node:path"
import { z, type ZodRawShape } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AppRegistry, InstalledApp } from "./app-registry.js"
import { paginate, pageParamsShape, toolText, type PageParams } from "./tool-envelope.js"
import { catchErrors, defineTool, type ToolTransformer } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { toMcpTool } from "@agentproto/mcp-server"

type McpTextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

/**
 * Local companion to the shared `paginated()` transformer for tools whose
 * LEGACY (non-paginated) output is not `paginated`'s `{[itemKey]: rows}`
 * wrapper — here `{appId, root, path, entries}`. Same cursor/limit/
 * compact/fields pipeline via the shared primitives, but the default
 * branch emits `defaultBody(projectedRows)`, and any non-array handler
 * output (this file's `errorResult(...)` replies) passes through
 * untouched.
 */
function paginatedLegacyList<TItem extends object>(opts: {
  project: (item: TItem) => object
  keyOf: (item: TItem) => string | number | null
  defaultBody: (rows: object[], input: unknown) => unknown
}): ToolTransformer<unknown, unknown, McpTextResult> {
  return {
    name: "paginatedLegacyList",
    wrapShape: (shape): ZodRawShape => ({ ...shape, ...pageParamsShape }),
    wrapHandler: inner => async input => {
      const params = (input ?? {}) as PageParams
      const out = (await inner(input)) as unknown
      if (!Array.isArray(out)) return out as McpTextResult
      const items = out as readonly TItem[]
      const full = params.full === true
      const compact = full ? false : params.compact !== false
      if (params.limit !== undefined || params.cursor !== undefined) {
        const page = paginate(items, params, { maxLimit: 200, keyOf: opts.keyOf })
        const rows = compact ? page.items.map(opts.project) : page.items
        return { content: [{ type: "text", text: toolText({ ...page, items: [...rows] }, params) }] }
      }
      const rows = compact ? items.map(opts.project) : [...items]
      return { content: [{ type: "text", text: JSON.stringify(opts.defaultBody(rows as object[], input)) }] }
    },
  }
}

/** Thrown when a relative external path resolves outside the granted root. */
export class ExternalPathTraversalError extends Error {
  readonly code = "EXTERNAL_PATH_TRAVERSAL"
  constructor(relPath: string) {
    super(
      `app-external: path traversal rejected for "${relPath}" — must resolve inside the granted root.`,
    )
    this.name = "ExternalPathTraversalError"
  }
}

/** Thrown when the caller's `root` argument isn't one of the app's granted
 *  `externalReadRoots` entries (exact string match required). */
export class ExternalRootNotGrantedError extends Error {
  readonly code = "EXTERNAL_ROOT_NOT_GRANTED"
  constructor(root: string, appId: string) {
    super(`app-external: root "${root}" is not granted to app "${appId}".`)
    this.name = "ExternalRootNotGrantedError"
  }
}

const TEXT_EXTENSIONS = new Set([".json", ".md", ".txt", ".csv", ".url", ".yaml", ".yml"])

/** Safety-net cap on `app_external_read` — not a normal-path limit
 *  (catalog.csv-scale files are fine), just a guard against accidentally
 *  reading a huge text file into a tool's JSON response. */
const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024

// Same invariant as app-data.ts's `resolveAppDataPath`, generalized to an
// arbitrary `root` instead of assuming an app's own `dir`: `resolve()`
// collapses `..`/`.` segments, so the only reliable check is that the
// resolved target is `root` itself or strictly below it.
export function resolveExternalPath(root: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new ExternalPathTraversalError(relPath)
  // Reject drive-letter prefixes so a Windows-form "C:foo" can never be
  // misinterpreted as a relative segment on a drive-based host.
  if (/^[A-Za-z]:/.test(relPath)) throw new ExternalPathTraversalError(relPath)
  const rootResolved = resolve(root)
  const target = resolve(rootResolved, relPath)
  const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  if (target !== rootResolved && !target.startsWith(rootWithSep)) {
    throw new ExternalPathTraversalError(relPath)
  }
  return target
}

/** Exact-match check: is `root` one of the app's granted
 *  `externalReadRoots`? No prefix/fuzzy matching — that would let a caller
 *  widen access to an unrelated sibling directory. Exported so the HTTP
 *  blob route (http-server.ts) shares this exact check instead of
 *  re-deriving it. */
export function isExternalRootGranted(installed: InstalledApp, root: string): boolean {
  return (installed.externalReadRoots ?? []).includes(root)
}

/** Throwing sibling of {@link isExternalRootGranted} for the MCP tool
 *  handlers below, which want a single `try`/`catch` around the whole
 *  guard sequence. */
function assertRootGranted(installed: InstalledApp, root: string): void {
  if (!isExternalRootGranted(installed, root)) {
    throw new ExternalRootNotGrantedError(root, installed.appId)
  }
}

/** Realpath-normalize the granted root once so relative segments can never
 *  climb out through a symlinked root. Undefined when the dir is gone.
 *  Exported for reuse by the HTTP blob route (http-server.ts) — same guard,
 *  not re-derived a third time. */
export async function realpathExternalRoot(root: string): Promise<string | undefined> {
  try {
    return await realpath(root)
  } catch {
    return undefined
  }
}

/** Best-effort symlink escape defence for an existing target — realpath the
 *  file/dir and assert it still lands inside `root`. Exported for reuse by
 *  the HTTP blob route (http-server.ts). */
export async function assertExternalPathRealInside(root: string, target: string): Promise<void> {
  let real: string
  try {
    real = await realpath(target)
  } catch {
    return
  }
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (real !== root && !real.startsWith(rootWithSep)) {
    throw new ExternalPathTraversalError(target)
  }
}

function textResult(body: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(body) }] }
}

function errorResult(text: string): {
  content: { type: "text"; text: string }[]
  isError: true
} {
  return { content: [{ type: "text", text: JSON.stringify({ error: text }) }], isError: true }
}

export interface RegisterAppExternalToolsOptions {
  appRegistry: AppRegistry
}

export function registerAppExternalTools(
  server: McpServer,
  opts: RegisterAppExternalToolsOptions,
): void {
  const { appRegistry } = opts

  type AppExternalListInput = {
    appId: string
    root: string
    path?: string
  }

  type AppExternalListEntry = { name: string; isDirectory: boolean; size?: number }

  const appExternalListTool = defineTool<AppExternalListInput, AppExternalListEntry[] | McpTextResult>({
    id: "app_external_list",
    description:
      "List directory entries (name, isDirectory, size for files) under one of " +
      "an installed app's granted `externalReadRoots`. `root` must exactly " +
      "match one of the app's granted roots; `path` (optional, default the " +
      "root itself) is resolved relative to it with the same traversal + " +
      "symlink-escape guard as app_data_list. Read-only — there is no " +
      "corresponding write/delete tool.",
    inputSchema: z.object({
      appId: z.string(),
      root: z.string().describe("Must exactly match one of the app's granted externalReadRoots entries."),
      path: z.string().optional().describe("Path relative to `root`. Defaults to the root itself."),
    }),
  })

  const appExternalListImpl = implementTool(appExternalListTool, async ({ input }) => {
    const installed = appRegistry.getApp(input.appId)
    if (!installed) return errorResult(`app_external_list: no installed app "${input.appId}".`)
    try {
      assertRootGranted(installed, input.root)
    } catch (err) {
      return errorResult(`app_external_list: ${err instanceof Error ? err.message : String(err)}`)
    }
    const root = await realpathExternalRoot(input.root)
    if (!root) return errorResult(`app_external_list: root "${input.root}" is not accessible.`)
    const relPath = input.path ?? ""
    let target: string
    try {
      target = resolveExternalPath(root, relPath)
      await assertExternalPathRealInside(root, target)
    } catch (err) {
      return errorResult(`app_external_list: ${err instanceof Error ? err.message : String(err)}`)
    }
    let dirents: { name: string; isDirectory(): boolean }[]
    try {
      dirents = await readdir(target, { withFileTypes: true })
    } catch (err) {
      return errorResult(
        `app_external_list: cannot list "${relPath || "."}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const entries: { name: string; isDirectory: boolean; size?: number }[] = []
    for (const d of dirents) {
      const isDirectory = d.isDirectory()
      if (isDirectory) {
        entries.push({ name: d.name, isDirectory })
        continue
      }
      let size = 0
      try {
        size = (await stat(join(target, d.name))).size
      } catch {
        size = 0
      }
      entries.push({ name: d.name, isDirectory, size })
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  })

  const appExternalListDriver = defineDriver({
    id: "agentproto-runtime-builtin",
    name: "agentproto runtime builtin",
    description:
      "Single-implementation builtin driver for daemon tools migrated " +
      "onto the AIP contract layer.",
    kind: "builtin",
    implements: [{ tool: appExternalListTool.id, version: "*" }],
    implementations: [appExternalListImpl],
  })

  toMcpTool(server, {
    tool: appExternalListTool,
    candidates: [appExternalListDriver],
    transformers: [
      catchErrors(),
      paginatedLegacyList({
        project: (entry: AppExternalListEntry) => entry,
        keyOf: e => e.name,
        defaultBody: (rows, listInput) => {
          const args = (listInput ?? {}) as { appId?: string; root?: string; path?: string }
          return { appId: args.appId, root: args.root, path: args.path ?? "", entries: rows }
        },
      }),
    ],
  })

  server.tool(
    "app_external_read",
    "Read a text-ish file (allowed extensions: .json .md .txt .csv .url " +
      ".yaml .yml) under one of an installed app's granted " +
      "`externalReadRoots`, as UTF-8 text — JSON paths return the parsed " +
      "value. `root` must exactly match a granted root; any other " +
      "extension (PDFs, images, …) or a file over ~2MB is rejected — fetch " +
      "those via `GET /apps/:appId/external-blob?root=&path=` instead. " +
      "Read-only — there is no corresponding write tool.",
    {
      appId: z.string(),
      root: z.string().describe("Must exactly match one of the app's granted externalReadRoots entries."),
      path: z.string().describe("Path relative to `root`."),
    },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) return errorResult(`app_external_read: no installed app "${input.appId}".`)
      try {
        assertRootGranted(installed, input.root)
      } catch (err) {
        return errorResult(`app_external_read: ${err instanceof Error ? err.message : String(err)}`)
      }
      const ext = extname(input.path).toLowerCase()
      if (!TEXT_EXTENSIONS.has(ext)) {
        return errorResult(
          `app_external_read: "${input.path}" has extension "${ext || "(none)"}", which is not ` +
            `text-ish (allowed: ${[...TEXT_EXTENSIONS].sort().join(", ")}). Use ` +
            `GET /apps/${input.appId}/external-blob?root=${encodeURIComponent(input.root)}&path=${encodeURIComponent(input.path)} ` +
            "to fetch this file's bytes instead.",
        )
      }
      const root = await realpathExternalRoot(input.root)
      if (!root) return errorResult(`app_external_read: root "${input.root}" is not accessible.`)
      let target: string
      try {
        target = resolveExternalPath(root, input.path)
        await assertExternalPathRealInside(root, target)
      } catch (err) {
        return errorResult(`app_external_read: ${err instanceof Error ? err.message : String(err)}`)
      }
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(target)
      } catch (err) {
        return errorResult(
          `app_external_read: cannot stat "${input.path}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (st.isDirectory()) {
        return errorResult(`app_external_read: "${input.path}" is a directory, not a file.`)
      }
      if (st.size > MAX_TEXT_READ_BYTES) {
        return errorResult(
          `app_external_read: "${input.path}" is ${st.size} bytes, over the ${MAX_TEXT_READ_BYTES}-byte ` +
            "text-read cap. Use the external-blob HTTP route instead.",
        )
      }
      let raw: string
      try {
        raw = await readFile(target, "utf8")
      } catch (err) {
        return errorResult(
          `app_external_read: cannot read "${input.path}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (ext === ".json") {
        try {
          return textResult({ appId: input.appId, root: input.root, path: input.path, content: JSON.parse(raw) })
        } catch {
          return textResult({ appId: input.appId, root: input.root, path: input.path, content: raw })
        }
      }
      return textResult({ appId: input.appId, root: input.root, path: input.path, content: raw })
    },
  )
}
