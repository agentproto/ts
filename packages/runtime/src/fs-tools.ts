/**
 * Filesystem MCP tools registered on the runtime's MCP server.
 *
 * The runtime already exposes AIP CRUD verbs (create_tool, load_agent, …)
 * via @agentproto/mcp-server. To make the workspace genuinely reachable
 * to remote MCP clients (Guilde cloud agents through a tunnel, IDEs,
 * etc.), we also register canonical filesystem tools that match the
 * shape used by `@modelcontextprotocol/server-filesystem` so existing
 * MCP-fs proxy clients can target the runtime without bespoke logic:
 *
 *   file_read        ({ path })          → string
 *   file_write       ({ path, content }) → "ok"
 *   directory_list   ({ path? })         → "[FILE] x\n[DIR]  y" lines
 *   file_info        ({ path })          → { name, type, size, modified }
 *   directory_create ({ path })          → "ok"
 *   file_delete      ({ path })          → "ok"
 *
 * All paths are resolved relative to the workspace root via the same
 * escape guard used by `WorkspaceFs`. Absolute paths inside the root
 * are accepted (so callers that prefix `basePath` with the absolute
 * workspace path keep working).
 *
 * Node confinement (AIP-34) sits next to the root confinement: once a path
 * is inside the root, it must also be visible to the CALLER session's node
 * scope, derived from that session's ground (`callerScope`). A path in a
 * sealed sibling, above the caller's sealed wall, or in another tree is
 * reported as absent. A caller that cannot be identified is refused. A host
 * call, and a session whose ground lies in no declared tree, are not walled.
 */

import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type AppBoundary, resolveBoundaryPath } from "./app-boundary.js"
import { assertServed, callerScopes, type CallerScope, type CallerScopes } from "./caller-scope.js"
import { paginate } from "./tool-envelope.js"

export interface RegisterFsToolsOptions {
  workspace: string
  /**
   * When set, the caller is an app-spawned session: relative paths resolve
   * against `boundary.root` (the app dir) instead of `workspace`, reads are
   * limited to the readable zones, and writes to the writable zones. See
   * `app-boundary.ts`.
   */
  boundary?: AppBoundary
  /** Whose node scope confines the paths. Missing or refused: every tool refuses. */
  callerScope: CallerScope
  /** Where trees are read from. Default: the daemon's shared instance. */
  scopes?: CallerScopes
}

class FsPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FsPathError"
  }
}

function makeAnchor(workspace: string): (input: string) => string {
  const root = resolve(workspace)
  return (input: string) => {
    if (typeof input !== "string" || input.length === 0) {
      throw new FsPathError("path must be a non-empty string")
    }
    const candidate = isAbsolute(input)
      ? normalize(input)
      : normalize(join(root, input))
    const rel = relative(root, candidate)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new FsPathError(`path escapes the workspace: '${input}'`)
    }
    return candidate
  }
}

function text(value: string | object): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  }
}

export function registerFsTools(
  server: McpServer,
  opts: RegisterFsToolsOptions,
): void {
  const workspaceAnchor = makeAnchor(opts.workspace)
  const boundary = opts.boundary
  const scopes = opts.scopes ?? callerScopes
  const visibleTo = (abs: string, input: string, subtree = false): string => {
    if (!scopes.pathVisible(opts.callerScope, abs, { subtree })) {
      throw new FsPathError(`ENOENT: no such file or directory '${input}'`)
    }
    return abs
  }
  const readAnchor = (input: string): string => {
    assertServed(opts.callerScope)
    return visibleTo(boundary ? resolveBoundaryPath(boundary, input, "read") : workspaceAnchor(input), input)
  }
  const writeAnchor = (input: string, subtree = false): string => {
    assertServed(opts.callerScope)
    return visibleTo(boundary ? resolveBoundaryPath(boundary, input, "write") : workspaceAnchor(input), input, subtree)
  }

  server.tool(
    "file_read",
    "Read a file from the workspace. Defaults to UTF-8 text; pass " +
      "encoding: \"base64\" for binary files (images, audio, video, …) — " +
      "UTF-8 decoding a non-text file replaces invalid byte sequences " +
      "(e.g. a PNG's 0x89 header byte) with U+FFFD, corrupting the content.",
    {
      path: z.string().describe("Workspace-relative path to the file."),
      encoding: z
        .enum(["utf8", "base64"])
        .optional()
        .describe(
          "\"utf8\" (default) for text files, \"base64\" for binary files.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Start of the read window: LINES for utf8 reads, BYTES for base64 reads. " +
            "Omit to read from the beginning.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Size of the read window: LINES for utf8 reads, BYTES for base64 reads. " +
            "Omit to read to the end of the file.",
        ),
    },
    async ({ path, encoding, offset, limit }) => {
      const abs = readAnchor(path)
      const buf = await readFile(abs)
      const isBase64 = encoding === "base64"
      if (offset === undefined && limit === undefined) {
        return text(buf.toString(isBase64 ? "base64" : "utf8"))
      }
      if (isBase64) {
        const start = Math.min(offset ?? 0, buf.length)
        const end = limit === undefined ? buf.length : Math.min(start + limit, buf.length)
        return text({
          content: buf.subarray(start, end).toString("base64"),
          truncated: end < buf.length,
          offset: start,
          returned: end - start,
          total: buf.length,
        })
      }
      const lines = buf.toString("utf8").split("\n")
      const start = Math.min(offset ?? 0, lines.length)
      const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length)
      return text({
        content: lines.slice(start, end).join("\n"),
        truncated: end < lines.length,
        offset: start,
        returned: end - start,
        total: lines.length,
      })
    },
  )

  server.tool(
    "file_write",
    "Write a file to the workspace. Parent directories are created on demand.",
    {
      path: z.string().describe("Workspace-relative path to the file."),
      content: z.string().describe("File body (UTF-8)."),
    },
    async ({ path, content }) => {
      const abs = writeAnchor(path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, "utf8")
      return text("ok")
    },
  )

  server.tool(
    "directory_list",
    "List entries of a directory in the workspace. Returns one '[FILE]' or '[DIR]' line per entry, mirroring `@modelcontextprotocol/server-filesystem`.",
    {
      path: z
        .string()
        .optional()
        .describe("Workspace-relative directory (defaults to workspace root)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max entries per page. Omit to return ALL entries (the default)."),
      cursor: z
        .string()
        .optional()
        .describe("Opaque token from a prior call's `nextCursor`."),
    },
    async ({ path, limit, cursor }) => {
      const abs = readAnchor(path && path.length > 0 ? path : ".")
      const entries = await readdir(abs, { withFileTypes: true })
      // Filter before pagination. A regular file belongs to the node of the
      // directory already checked, so only directories and links are located.
      const shown = entries.filter(e => e.isFile() || scopes.pathVisible(opts.callerScope, join(abs, e.name)))
      const lines = shown.map(e =>
        e.isDirectory() ? `[DIR]  ${e.name}` : `[FILE] ${e.name}`,
      )
      if (limit === undefined && cursor === undefined) {
        return text(lines.join("\n"))
      }
      const page = paginate(lines, { limit, cursor }, { maxLimit: 200 })
      return text(page)
    },
  )

  server.tool(
    "file_info",
    "Stat a file or directory in the workspace.",
    { path: z.string().describe("Workspace-relative path.") },
    async ({ path }) => {
      const abs = readAnchor(path)
      const info = await stat(abs)
      return text({
        name: abs.split("/").pop() ?? path,
        path,
        type: info.isDirectory() ? "directory" : "file",
        size: info.size,
        modified: info.mtime.toISOString(),
        created: info.birthtime.toISOString(),
      })
    },
  )

  server.tool(
    "directory_create",
    "Create a directory (recursive) in the workspace.",
    { path: z.string().describe("Workspace-relative directory path.") },
    async ({ path }) => {
      const abs = writeAnchor(path)
      await mkdir(abs, { recursive: true })
      return text("ok")
    },
  )

  server.tool(
    "file_delete",
    "Delete a file or empty directory in the workspace.",
    { path: z.string().describe("Workspace-relative path.") },
    async ({ path }) => {
      const abs = writeAnchor(path, true)
      await rm(abs, { recursive: true, force: true })
      return text("ok")
    },
  )
}
