/**
 * Workspace toolset — gives the Mastra agent the ability to inspect, edit, and
 * run commands inside its session working directory, like a coding agent.
 *
 * SAFETY: every file path is resolved against the session `cwd` and rejected if
 * it escapes (no `../` traversal, no absolute paths outside cwd). Command
 * execution runs with `cwd` and a timeout, and is gated by `allowExec` (the CLI
 * sets it from `AGENTPROTO_MASTRA_NO_EXEC`). The agent only ever touches the
 * directory the daemon spawned it in.
 *
 * ## Tool id vocabulary
 *
 * Two tool-id vocabularies exist in this codebase for the same operations:
 * this adapter's own coding-agent style (`list_dir`, `read_file`, `write_file`,
 * `run_command`, ...) and the daemon's MCP-filesystem-compatible style
 * (`directory_list`, `file_read`, `file_write`, `file_info`, `command_execute`,
 * matching `packages/runtime/src/fs-tools.ts` / `command-tools.ts`). Apps'
 * AGENT.md `tools:` lists have shipped with either vocabulary (see
 * `packages/apps/src/media-viewer/agents/cataloger.ts` mixing `list_dir` +
 * `file_info`), so both id sets resolve here — the daemon-style ids are
 * aliases over the same implementations, plus `file_info` and `command_execute`
 * which have no adapter-style equivalent.
 *
 * ## Fail-fast for unresolved tool refs
 *
 * `resolveTool` in `default-agent.ts` no longer silently drops an AGENT.md
 * tool ref that doesn't match anything here — see `makeUnwiredToolStub`. A
 * declared-but-unwired tool stays visible to the model and fails fast and
 * clearly instead of the model either never seeing it (silent drop) or
 * hallucinating a call the SDK can't resolve, which used to surface as an
 * opaque `NoSuchToolError` this adapter's ACP layer then dropped on the
 * floor (see `tool-call-map.ts`'s `tool-error` handling), leaving the turn
 * looking hung with zero recorded tool calls.
 *
 * ## Execution guard
 *
 * Every tool's `execute` is wrapped with a hard timeout (`execTimeoutMs`,
 * default 120s) so a stalled fs op or an unresponsive allowlist check can't
 * block a turn indefinitely — past the deadline the call rejects with a
 * clear timeout error (surfaced to the model as a normal tool failure) in
 * place of an unbounded hang.
 */

import { exec, execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { createTool } from "@mastra/core/tools"
import type { MastraToolLike } from "@agentproto/mastra"
import {
  interpreterExecWarning,
  isCommandAllowed,
  isInterpreterBasename,
  loadAllowlistEntries,
} from "@agentproto/runtime/command-allowlist"
import { z } from "zod"

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

/** A Mastra tool (structural — avoids coupling to a @mastra/core type name). */
export interface WorkspaceTool {
  id: string
}

/** `command`'s argv0 must be one of these for `run_tests` — no arbitrary exec. */
const ALLOWED_TEST_ARGV0 = new Set(["npm", "pnpm", "yarn", "node", "npx"])

/** Keep tool output bounded — return only the tail. */
function tail(s: string, maxChars = 4000): string {
  return s.length > maxChars ? s.slice(-maxChars) : s
}

/** Pull the file paths a unified diff touches out of its `---`/`+++` headers. */
function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split("\n")) {
    const m = /^(?:\+\+\+|---) (?:a\/|b\/)?(.+?)(?:\t.*)?$/.exec(line)
    if (!m) continue
    const p = m[1]!.trim()
    if (p === "/dev/null") continue
    paths.add(p)
  }
  return [...paths]
}

/**
 * Wrap a tool's `execute` so it can never block a turn past `timeoutMs` — a
 * stalled fs call, a hung subprocess, or an unresponsive allowlist read all
 * reject with a clear, tool-attributed timeout error instead of leaving the
 * model's tool call pending forever.
 */
export function withTimeoutGuard<Input, Output>(
  id: string,
  timeoutMs: number,
  execute: (input: Input) => Promise<Output>,
): (input: Input) => Promise<Output> {
  return async (input: Input) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        execute(input),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `tool '${id}' timed out after ${timeoutMs}ms (adapter execution guard) — ` +
                  `aborted so the turn can't hang indefinitely.`,
              ),
            )
          }, timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface WorkspaceToolsOptions {
  /** Absolute path the agent is confined to (the spawn cwd). */
  cwd: string
  /** When false, `run_command` (and the other exec-gated tools) are omitted. Default true. */
  allowExec?: boolean
  /** Per-tool execution timeout (ms), enforced on every tool by `withTimeoutGuard`. Default 120_000. */
  execTimeoutMs?: number
  /**
   * Exact absolute paths OUTSIDE `cwd` the READ-ONLY tools (`read_file`,
   * `file_read`, `file_info`) may additionally access. The daemon hands down
   * the AGENTS.md file an inherited pointer prompt names
   * (`AGENTPROTO_ADDITIONAL_READ_PATHS`, see `session-spawn.ts`) so the
   * agent can actually read the contract it was told to load first.
   * Deliberately narrow: exact files only (no parent-dir listing), the
   * write tools (`write_file`, `edit_file`, …) never honour the grant, and
   * sibling paths stay rejected — `escapes the workspace` still throws for
   * everything else.
   */
  additionalReadPaths?: string[]
  /**
   * Extra tools merged over the built-ins, keyed by id — lets an embedding
   * host add tools the built-in toolset doesn't cover. On id collision, an
   * extra tool wins over a built-in of the same id.
   */
  extraTools?: Record<string, MastraToolLike>
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
 * Stub tool for an AGENT.md-declared tool id this adapter has no executor
 * for. Resolving to THIS instead of dropping the ref keeps the id visible
 * in the model's function-calling schema — a call fails immediately with a
 * clear message, instead of the ref being silently dropped (model can't
 * even try) or an unresolved call surfacing as an opaque provider error
 * this adapter's ACP layer then loses (see `tool-call-map.ts`).
 */
export function makeUnwiredToolStub(id: string): ReturnType<typeof createTool> {
  return createTool({
    id,
    description:
      `NOT WIRED: '${id}' is declared in this agent's AGENT.md but this adapter has no executor ` +
      `for it. Calling it always fails immediately with an error — do not retry it.`,
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.object({ error: z.string() }),
    execute: async () => {
      throw new Error(
        `tool '${id}' is declared in AGENT.md but not wired to any executor in this adapter ` +
          `(adapters/mastra-agent/src/workspace-tools.ts). This call cannot succeed — stop retrying it.`,
      )
    },
  })
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
  // Exact-file READ grant (see WorkspaceToolsOptions.additionalReadPaths) —
  // normalized to resolved absolute paths, deduped.
  const additionalReadPaths = new Set(
    (opts.additionalReadPaths ?? []).filter(isAbsolute).map(p => resolve(p)),
  )
  /**
   * Resolve a path for a WRITE-capable tool: confined to cwd, no grant.
   */
  const resolveForWrite = (p: string): string => resolveInCwd(cwd, p)
  /**
   * Resolve a path for a READ-ONLY tool: cwd-confined like everything else,
   * PLUS the exact-file grant — a path explicitly listed in
   * `additionalReadPaths` (the daemon's AGENTS.md pointer contract) is
   * allowed as an exact file, while everything outside cwd (including the
   * granted files' parents and siblings) still throws.
   */
  const resolveForRead = (p: string): string => {
    try {
      return resolveInCwd(cwd, p)
    } catch (err) {
      const target = isAbsolute(p) ? resolve(p) : resolve(cwd, p)
      if (additionalReadPaths.has(target)) return target
      throw err
    }
  }
  /**
   * Shared env for all exec calls — sets GIT_CEILING_DIRECTORIES to prevent
   * git from discovering repos above cwd (fixes #818: read_diff escaping the
   * workspace to operate on an enclosing repo).
   */
  const execEnv = { ...process.env, GIT_CEILING_DIRECTORIES: resolve(cwd, "..") }

  const guard = <Input, Output>(id: string, execute: (input: Input) => Promise<Output>) =>
    withTimeoutGuard(id, execTimeoutMs, execute)

  const doListDir = async (input: { path?: string }) => {
    const dir = resolveInCwd(cwd, input.path ?? ".")
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    return {
      entries: dirents.map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort(),
    }
  }

  const doReadFile = async (input: { path: string }) => {
    const file = resolveForRead(input.path)
    return { content: await fs.readFile(file, "utf8") }
  }

  const doWriteFile = async (input: { path: string; content: string }) => {
    const file = resolveForWrite(input.path)
    await fs.mkdir(resolve(file, ".."), { recursive: true })
    await fs.writeFile(file, input.content, "utf8")
    return { path: input.path, bytes: Buffer.byteLength(input.content, "utf8") }
  }

  const list_dir = createTool({
    id: "list_dir",
    description:
      "List the entries of a directory in the workspace. Returns names with a trailing '/' for directories. Path is relative to the workspace root (default '.').",
    inputSchema: z.object({
      path: z.string().default(".").describe("Directory path, relative to the workspace root."),
    }),
    outputSchema: z.object({ entries: z.array(z.string()) }),
    execute: guard("list_dir", doListDir),
  })

  const directory_list = createTool({
    id: "directory_list",
    description: "Alias of `list_dir` (daemon-vocabulary id) — list a workspace directory's entries.",
    inputSchema: z.object({
      path: z.string().default(".").describe("Directory path, relative to the workspace root."),
    }),
    outputSchema: z.object({ entries: z.array(z.string()) }),
    execute: guard("directory_list", doListDir),
  })

  const read_file = createTool({
    id: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Path is relative to the workspace root.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root."),
    }),
    outputSchema: z.object({ content: z.string() }),
    execute: guard("read_file", doReadFile),
  })

  const file_read = createTool({
    id: "file_read",
    description: "Alias of `read_file` (daemon-vocabulary id) — read a UTF-8 text file from the workspace.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root."),
    }),
    outputSchema: z.object({ content: z.string() }),
    execute: guard("file_read", doReadFile),
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
    execute: guard("write_file", doWriteFile),
  })

  const file_write = createTool({
    id: "file_write",
    description: "Alias of `write_file` (daemon-vocabulary id) — write a UTF-8 text file to the workspace.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root."),
      content: z.string().describe("Full file contents to write."),
    }),
    outputSchema: z.object({ path: z.string(), bytes: z.number() }),
    execute: guard("file_write", doWriteFile),
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
    execute: guard("edit_file", async (input: { path: string; old_string: string; new_string: string }) => {
      const file = resolveForWrite(input.path)
      const current = await fs.readFile(file, "utf8")
      const count = current.split(input.old_string).length - 1
      if (count === 0) throw new Error(`old_string not found in '${input.path}'.`)
      if (count > 1) {
        throw new Error(`old_string occurs ${count}× in '${input.path}' — make it unique.`)
      }
      await fs.writeFile(file, current.replace(input.old_string, input.new_string), "utf8")
      return { path: input.path, replaced: true }
    }),
  })

  const file_info = createTool({
    id: "file_info",
    description:
      "Stat a file or directory in the workspace — returns name, type, size (bytes), and modified/created timestamps.",
    inputSchema: z.object({
      path: z.string().describe("File or directory path, relative to the workspace root."),
    }),
    outputSchema: z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(["file", "directory"]),
      size: z.number(),
      modified: z.string(),
      created: z.string(),
    }),
    execute: guard("file_info", async (input: { path: string }) => {
      const abs = resolveForRead(input.path)
      const info = await fs.stat(abs)
      return {
        name: abs.split(sep).pop() ?? input.path,
        path: input.path,
        type: info.isDirectory() ? ("directory" as const) : ("file" as const),
        size: info.size,
        modified: info.mtime.toISOString(),
        created: info.birthtime.toISOString(),
      }
    }),
  })

  const tools: Record<string, ReturnType<typeof createTool>> = {
    list_dir,
    directory_list,
    read_file,
    file_read,
    write_file,
    file_write,
    edit_file,
    file_info,
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
      execute: guard("run_command", async (input: { command: string }) => {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd,
            timeout: execTimeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: execEnv,
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
      }),
    })

    tools.command_execute = createTool({
      id: "command_execute",
      description:
        "Run an allowlisted command in the workspace directory. The command's basename must appear in " +
        "<workspace>/.agentproto/allowed-commands.json (default-deny — a missing or empty file means " +
        "nothing runs). Unlike `run_command`, args are passed as an argv array with no shell interpolation " +
        "(spawned with shell:false). Returns stdout/stderr/exitCode.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .describe("Executable name or path — checked against the allowlist by basename."),
        args: z
          .array(z.string())
          .optional()
          .describe("Argv array, passed verbatim (no shell expansion)."),
      }),
      outputSchema: z.object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
        warning: z.string().optional(),
      }),
      execute: guard("command_execute", async (input: { command: string; args?: string[] }) => {
        const allowlistEntries = await loadAllowlistEntries(cwd)
        const baseName = basename(input.command)
        if (!isCommandAllowed(allowlistEntries, baseName, input.args ?? [])) {
          const allowedBasenames =
            [...new Set(allowlistEntries.map((e) => e.command))].sort().join(", ") || "(empty)"
          const basenameKnown = allowlistEntries.some((e) => e.command === baseName)
          throw new Error(
            basenameKnown
              ? `command_execute: '${baseName}' is allowlisted but its argv doesn't match any allowed ` +
                `pattern for it. Check the "args" constraints in .agentproto/allowed-commands.json.`
              : `command_execute: '${baseName}' is not in the workspace allowlist. Add it to ` +
                `.agentproto/allowed-commands.json under "commands": [...]. Currently allowed: ${allowedBasenames}.`,
          )
        }
        const warning = isInterpreterBasename(baseName) ? interpreterExecWarning(baseName) : undefined
        if (warning) console.error(`[command_execute] ⚠ ${warning}`)
        try {
          const { stdout, stderr } = await execFileAsync(input.command, input.args ?? [], {
            cwd,
            timeout: execTimeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: execEnv,
          })
          return { stdout, stderr, exitCode: 0, ...(warning ? { warning } : {}) }
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
          return {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? e.message ?? String(err),
            exitCode: typeof e.code === "number" ? e.code : 1,
            ...(warning ? { warning } : {}),
          }
        }
      }),
    })

    tools.read_diff = createTool({
      id: "read_diff",
      description:
        "Show `git diff` for the workspace — staged and unstaged changes against HEAD (or against `base` if given), as unified diff text. Optionally scoped to `paths`.",
      inputSchema: z.object({
        paths: z
          .array(z.string())
          .optional()
          .describe("Restrict the diff to these paths, relative to the workspace root."),
        base: z.string().optional().describe("Git ref to diff against. Defaults to HEAD."),
      }),
      outputSchema: z.object({ diff: z.string() }),
      execute: guard("read_diff", async (input: { paths?: string[]; base?: string }) => {
        const relPaths = (input.paths ?? []).map((p) => {
          const abs = resolveForRead(p)
          return relative(cwd, abs) || "."
        })
        const args = [
          "diff",
          input.base ?? "HEAD",
          ...(relPaths.length ? ["--", ...relPaths] : []),
        ]
        try {
          const { stdout } = await execFileAsync("git", args, {
            cwd,
            timeout: execTimeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: execEnv,
          })
          return { diff: stdout }
        } catch (err) {
          const e = err as { stderr?: string; message?: string }
          throw new Error(`git diff failed: ${e.stderr ?? e.message ?? String(err)}`)
        }
      }),
    })

    tools.apply_patch = createTool({
      id: "apply_patch",
      description:
        "Apply a unified diff to files in the workspace (`git apply --whitespace=nowarn`). Paths in the patch that escape the workspace are rejected.",
      inputSchema: z.object({
        patch: z.string().describe("Unified diff text to apply."),
      }),
      outputSchema: z.object({ applied: z.boolean(), output: z.string() }),
      execute: guard("apply_patch", async (input: { patch: string }) => {
        for (const p of extractPatchPaths(input.patch)) {
          resolveForWrite(p) // throws if the patch touches a path outside cwd
        }
        const patchFile = join(tmpdir(), `mastra-agent-patch-${randomUUID()}.diff`)
        await fs.writeFile(patchFile, input.patch, "utf8")
        try {
          const { stdout, stderr } = await execFileAsync(
            "git",
            ["apply", "--whitespace=nowarn", patchFile],
            { cwd, timeout: execTimeoutMs, maxBuffer: 10 * 1024 * 1024, env: execEnv },
          )
          return { applied: true, output: stdout || stderr || "" }
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string }
          throw new Error(`git apply failed: ${e.stderr ?? e.stdout ?? e.message ?? String(err)}`)
        } finally {
          await fs.unlink(patchFile).catch(() => {})
        }
      }),
    })

    tools.run_tests = createTool({
      id: "run_tests",
      description:
        "Run the workspace's test command (default `npm test`, overridable via `command` or the MASTRA_AGENT_TEST_CMD env) and return its exit code + output tail.",
      inputSchema: z.object({
        command: z
          .string()
          .optional()
          .describe("Override the test command. Its argv0 must be one of npm, pnpm, yarn, node, npx."),
      }),
      outputSchema: z.object({ exitCode: z.number(), output: z.string() }),
      execute: guard("run_tests", async (input: { command?: string }) => {
        const commandStr = input.command ?? process.env.MASTRA_AGENT_TEST_CMD ?? "npm test"
        const argv0 = commandStr.trim().split(/\s+/)[0]
        if (!argv0 || !ALLOWED_TEST_ARGV0.has(argv0)) {
          throw new Error(
            `run_tests: command '${commandStr}' is not allowed — argv0 must be one of ${[...ALLOWED_TEST_ARGV0].join(", ")}.`,
          )
        }
        try {
          const { stdout, stderr } = await execAsync(commandStr, {
            cwd,
            timeout: execTimeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: execEnv,
          })
          return { exitCode: 0, output: tail(stdout + stderr) }
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
          return {
            exitCode: typeof e.code === "number" ? e.code : 1,
            output: tail((e.stdout ?? "") + (e.stderr ?? e.message ?? String(err))),
          }
        }
      }),
    })
  }

  return {
    ...tools,
    ...(opts.extraTools as Record<string, ReturnType<typeof createTool>> | undefined),
  }
}
