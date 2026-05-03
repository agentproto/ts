/**
 * @agentproto/mcp-server — exposes AIP doctype verbs as MCP tools.
 *
 * Hand a list of `DoctypeSpec` instances (one per registered AIP) and
 * optionally a workspace dir; the server registers
 * `create_<name> / load_<name> / list_<name> / update_<name> /
 * resolve_<name> / delete_<name>` for each spec, including AIP-40
 * extensions auto-loaded from `<workspace>/extensions/<slug>/EXTENSION.md`.
 *
 * Two ways to run it:
 *   1. **Embedded** — call `createMcpServer({ specs, workspace })` and
 *      attach to your own transport (stdio, websocket, …).
 *   2. **Standalone** — `runStdioServer({ specs, workspace })` wires
 *      stdio for you. Useful as a `mcp_servers.<id>` config entry on
 *      Claude Desktop / Cursor / any MCP host.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import {
  parseExtensionManifest,
  specFromExtension,
} from "@agentproto/extension"

// `RegisterableSpec<TParams, THandle>` is just `DoctypeSpec` plus the
// constraint that callers passing different generics across the array
// must type-erase via `as unknown as DoctypeSpec<...>` at the boundary.
// We don't try to express the heterogeneous list in TS — same trick
// `@agentproto/driver`'s `implementations[]` uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpec = DoctypeSpec<any, any>

export interface CreateMcpServerOptions {
  /** Doctype specs registered as MCP tools. One per AIP. */
  specs: readonly AnySpec[]
  /**
   * Optional workspace dir. If provided, the server scans
   * `<workspace>/extensions/` for `EXTENSION.md` files and registers
   * each as a local doctype. The parent of each extension is resolved
   * by matching the extension's `extends:` field (`aip-N`) against
   * `specs.find(s => s.aip === N)` — so the spec list MUST include the
   * parents the extensions reference, else loading throws.
   */
  workspace?: string
  /** Server name advertised over MCP. Default `agentproto-mcp-server`. */
  name?: string
  /** Server version advertised over MCP. Default `0.1.0-alpha`. */
  version?: string
}

export interface CreateMcpServerResult {
  /** The wired McpServer; attach a transport to start serving. */
  server: McpServer
  /**
   * The list of doctype names the server registered tools for —
   * useful for tests + diagnostics. Includes any extensions loaded
   * from `workspace/extensions/`.
   */
  registered: readonly string[]
}

export async function createMcpServer(
  opts: CreateMcpServerOptions,
): Promise<CreateMcpServerResult> {
  const server = new McpServer({
    name: opts.name ?? "agentproto-mcp-server",
    version: opts.version ?? "0.1.0-alpha",
  })

  const allSpecs: AnySpec[] = [...opts.specs]

  // Load extensions when a workspace is given.
  if (opts.workspace) {
    const extensions = await loadExtensions(opts.workspace, opts.specs)
    allSpecs.push(...extensions)
  }

  // Path-anchoring: when a workspace is set, resolve all relative
  // dir/path arguments against it. Agents pass logical paths like
  // "tools" or "tools/echo/TOOL.md"; the server pins them to the
  // workspace so they don't leak into process.cwd() (which is
  // wherever the host happened to spawn the server).
  const anchor = (p: string): string =>
    isAbsolute(p) || !opts.workspace ? p : join(opts.workspace, p)

  for (const spec of allSpecs) {
    registerVerbs(server, spec, anchor)
  }

  return {
    server,
    registered: allSpecs.map((s) => s.name),
  }
}

/**
 * Wire `createMcpServer` to stdio for use as an `mcp_servers.<id>`
 * entry on Claude Desktop / Cursor / etc. Resolves once the
 * transport closes.
 */
export async function runStdioServer(
  opts: CreateMcpServerOptions,
): Promise<void> {
  const { server } = await createMcpServer(opts)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// ── verb registration ───────────────────────────────────────────────

function registerVerbs(
  server: McpServer,
  spec: AnySpec,
  anchor: (p: string) => string,
): void {
  const verbs = createVerbs(spec)
  // Tool name uses snake_case to match MCP convention; spec.name may
  // be kebab (driver-cli) or namespaced (acme:deal). Map all to snake.
  const verbName = (verb: string) =>
    `${verb}_${spec.name.replace(/[-:]/g, "_")}`
  const description = (verb: string, body: string) =>
    `${verb} the AIP-${spec.aip} ${spec.name} doctype. ${body}`

  // create
  server.tool(
    verbName("create"),
    description(
      "create",
      "Author a new manifest from params. Returns { path, rendered }.",
    ),
    {
      params: z
        .record(z.string(), z.unknown())
        .describe(`The ${spec.name} definition fields.`),
      dir: z.string().describe("Workspace-relative or absolute target directory."),
      body: z
        .string()
        .optional()
        .describe("Markdown body after the frontmatter. Defaults to a stub."),
      dryRun: z
        .boolean()
        .optional()
        .describe("Render only — don't write to disk."),
    },
    async ({ params, dir, body, dryRun }) => {
      const result = await verbs.create(params, {
        dir: anchor(dir),
        body,
        dryRun,
      })
      return contentText({
        path: result.path,
        rendered: result.rendered,
      })
    },
  )

  // load
  server.tool(
    verbName("load"),
    description("load", "Read a manifest from disk. Returns the parsed handle."),
    {
      path: z.string().describe("Absolute or workspace-relative path to the .md file."),
    },
    async ({ path }) => {
      const result = await verbs.load(anchor(path))
      return contentText({ path: result.path, handle: result.handle })
    },
  )

  // list
  server.tool(
    verbName("list"),
    description(
      "list",
      "Walk a directory tree and return all manifests of this doctype.",
    ),
    {
      dir: z.string().describe("Directory to walk."),
      skipDirs: z
        .array(z.string())
        .optional()
        .describe("Subdir names to skip (default: node_modules, .git, dist)."),
    },
    async ({ dir, skipDirs }) => {
      const handles = await verbs.list(anchor(dir), { skipDirs })
      return contentText({ count: handles.length, handles })
    },
  )

  // update
  server.tool(
    verbName("update"),
    description(
      "update",
      "Patch an existing manifest. The patch is shallow-merged into the existing params.",
    ),
    {
      path: z.string().describe("Path to the manifest to update."),
      patch: z
        .record(z.string(), z.unknown())
        .describe("Partial fields to merge into the existing manifest."),
      body: z.string().optional().describe("New body markdown (default: keep existing)."),
    },
    async ({ path, patch, body }) => {
      const result = await verbs.update(
        anchor(path),
        (existing: Record<string, unknown>) => ({ ...existing, ...patch }),
        { body },
      )
      return contentText({ path: result.path, rendered: result.rendered })
    },
  )

  // resolve
  server.tool(
    verbName("resolve"),
    description(
      "resolve",
      "Resolve an inline | ref | file block to a fully-typed handle.",
    ),
    {
      block: z
        .union([
          z.object({ inline: z.record(z.string(), z.unknown()) }),
          z.object({ ref: z.string() }),
          z.object({ file: z.string() }),
        ])
        .describe("The composition block."),
      baseDir: z
        .string()
        .optional()
        .describe("Base dir for `file:` references."),
    },
    async ({ block, baseDir }) => {
      const handle = await verbs.resolve(block, {
        baseDir: baseDir ? anchor(baseDir) : undefined,
      })
      return contentText({ handle })
    },
  )

  // delete
  server.tool(
    verbName("delete"),
    description("delete", "Remove a manifest file from disk."),
    {
      path: z.string().describe("Path to the manifest to delete."),
    },
    async ({ path }) => {
      const target = anchor(path)
      await verbs.delete(target)
      return contentText({ deleted: target })
    },
  )
}

// ── extension loader ────────────────────────────────────────────────

async function loadExtensions(
  workspace: string,
  specs: readonly AnySpec[],
): Promise<AnySpec[]> {
  const extDir = resolve(workspace, "extensions")
  if (!existsSync(extDir)) return []

  const out: AnySpec[] = []
  const { readdir } = await import("node:fs/promises")
  type SimpleDirent = { name: string; isDirectory(): boolean }

  let entries: SimpleDirent[]
  try {
    entries = (await readdir(extDir, {
      withFileTypes: true,
    })) as unknown as SimpleDirent[]
  } catch {
    return out
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(extDir, String(entry.name), "EXTENSION.md")
    if (!existsSync(manifestPath)) continue

    const source = await readFile(manifestPath, "utf8")
    const parsed = parseExtensionManifest(source)
    const ext = parsed.frontmatter

    let parent: AnySpec | undefined
    if (ext.extends && ext.extends !== "none") {
      const aipMatch = ext.extends.match(/^aip-(\d+)$/)
      if (!aipMatch) {
        throw new Error(
          `mcp-server: extension '${ext.slug}' has invalid extends '${ext.extends}'`,
        )
      }
      const parentAip = Number(aipMatch[1])
      parent = specs.find((s) => s.aip === parentAip)
      if (!parent) {
        throw new Error(
          `mcp-server: extension '${ext.slug}' extends aip-${parentAip}, but no spec for that AIP was registered. Pass the parent spec in opts.specs.`,
        )
      }
    }

    out.push(specFromExtension(ext, { parent }) as AnySpec)
  }

  return out
}

// ── tool result helpers ─────────────────────────────────────────────

function contentText(payload: unknown): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}
