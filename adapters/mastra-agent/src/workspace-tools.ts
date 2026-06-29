/**
 * Workspace toolset — gives the Mastra agent the ability to inspect, edit, and
 * run commands inside its session working directory, like a coding agent.
 *
 * SAFETY: every file path is resolved against the session `cwd` and rejected if
 * it escapes (no `../` traversal, no absolute paths outside cwd). Command
 * execution runs with `cwd` and a timeout, and is gated by `allowExec` (the CLI
 * sets it from `AGENTPROTO_MASTRA_NO_EXEC`). The agent only ever touches the
 * directory the daemon spawned it in.
 */

import { exec } from "node:child_process"
import { promises as fs } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { createTool } from "@mastra/core/tools"
import { z } from "zod"

const execAsync = promisify(exec)

/** A Mastra tool (structural — avoids coupling to a @mastra/core type name). */
export interface WorkspaceTool {
  id: string
}

export interface WorkspaceToolsOptions {
  /** Absolute path the agent is confined to (the spawn cwd). */
  cwd: string
  /** When false, `run_command` is omitted from the toolset. Default true. */
  allowExec?: boolean
  /** Per-command timeout (ms). Default 120_000. */
  execTimeoutMs?: number
}

/** Resolve `p` against `cwd`, throwing if the result escapes the workspace. */
export function resolveInCwd(cwd: string, p: string): string {
  const base = resolve(cwd)
  const target = isAbsolute(p) ? resolve(p) : resolve(base, p)
  const rel = relative(base, target)
  if (rel === "" ) return target // the workspace root itself
  if (rel.startsWith("..") || (isAbsolute(rel) && !target.startsWith(base + sep))) {
    throw new Error(
      `path '${p}' escapes the workspace (resolved to '${target}', outside '${base}').`,
    )
  }
  return target
}

/**
 * Build the workspace toolset, all confined to `cwd`. Returns a record keyed by
 * tool id (also the AGENT.md tool ref the resolver matches).
 */
export function makeWorkspaceTools(
  opts: WorkspaceToolsOptions,
): Record<string, ReturnType<typeof createTool>> {
  const cwd = resolve(opts.cwd)
  const allowExec = opts.allowExec ?? true
  const execTimeoutMs = opts.execTimeoutMs ?? 120_000

  const list_dir = createTool({
    id: "list_dir",
    description:
      "List the entries of a directory in the workspace. Returns names with a trailing '/' for directories. Path is relative to the workspace root (default '.').",
    inputSchema: z.object({
      path: z.string().default(".").describe("Directory path, relative to the workspace root."),
    }),
    outputSchema: z.object({ entries: z.array(z.string()) }),
    execute: async (input: { path?: string }) => {
      const dir = resolveInCwd(cwd, input.path ?? ".")
      const dirents = await fs.readdir(dir, { withFileTypes: true })
      return {
        entries: dirents.map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort(),
      }
    },
  })

  const read_file = createTool({
    id: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Path is relative to the workspace root.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root."),
    }),
    outputSchema: z.object({ content: z.string() }),
    execute: async (input: { path: string }) => {
      const file = resolveInCwd(cwd, input.path)
      return { content: await fs.readFile(file, "utf8") }
    },
  })

  const write_file = createTool({
    id: "write_file",
    description:
      "Write (creating or overwriting) a UTF-8 text file in the workspace. Creates parent directories as needed. Path is relative to the workspace root.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root."),
      content: z.string().describe("Full file contents to write."),
    }),
    outputSchema: z.object({ path: z.string(), bytes: z.number() }),
    execute: async (input: { path: string; content: string }) => {
      const file = resolveInCwd(cwd, input.path)
      await fs.mkdir(resolve(file, ".."), { recursive: true })
      await fs.writeFile(file, input.content, "utf8")
      return { path: input.path, bytes: Buffer.byteLength(input.content, "utf8") }
    },
  })

  const edit_file = createTool({
    id: "edit_file",
    description:
      "Replace an exact substring in a workspace file. `old_string` must occur exactly once. Use for targeted edits instead of rewriting the whole file.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root."),
      old_string: z.string().describe("Exact text to replace (must be unique in the file)."),
      new_string: z.string().describe("Replacement text."),
    }),
    outputSchema: z.object({ path: z.string(), replaced: z.boolean() }),
    execute: async (input: { path: string; old_string: string; new_string: string }) => {
      const file = resolveInCwd(cwd, input.path)
      const current = await fs.readFile(file, "utf8")
      const count = current.split(input.old_string).length - 1
      if (count === 0) throw new Error(`old_string not found in '${input.path}'.`)
      if (count > 1) {
        throw new Error(`old_string occurs ${count}× in '${input.path}' — make it unique.`)
      }
      await fs.writeFile(file, current.replace(input.old_string, input.new_string), "utf8")
      return { path: input.path, replaced: true }
    },
  })

  const tools: Record<string, ReturnType<typeof createTool>> = {
    list_dir,
    read_file,
    write_file,
    edit_file,
  }

  if (allowExec) {
    tools.run_command = createTool({
      id: "run_command",
      description:
        "Run a shell command in the workspace directory and return its stdout/stderr/exit code. Runs with a timeout; use for builds, tests, git, etc.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to run (executed in the workspace root)."),
      }),
      outputSchema: z.object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
      }),
      execute: async (input: { command: string }) => {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd,
            timeout: execTimeoutMs,
            maxBuffer: 10 * 1024 * 1024,
          })
          return { stdout, stderr, exitCode: 0 }
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
          return {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? e.message ?? String(err),
            exitCode: typeof e.code === "number" ? e.code : 1,
          }
        }
      },
    })
  }

  return tools
}
