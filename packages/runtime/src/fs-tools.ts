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
import { paginate } from "./tool-envelope.js"

export interface RegisterFsToolsOptions {
  workspace: string
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
  const anchor = makeAnchor(opts.workspace)

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
      const abs = anchor(path)
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
      const abs = anchor(path)
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
      const abs = anchor(path && path.length > 0 ? path : ".")
      const entries = await readdir(abs, { withFileTypes: true })
      const lines = entries.map(e =>
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
      const abs = anchor(path)
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
      const abs = anchor(path)
      await mkdir(abs, { recursive: true })
      return text("ok")
    },
  )

  server.tool(
    "file_delete",
    "Delete a file or empty directory in the workspace.",
    { path: z.string().describe("Workspace-relative path.") },
    async ({ path }) => {
      const abs = anchor(path)
      await rm(abs, { recursive: true, force: true })
      return text("ok")
    },
  )
}
