/**
 * AIP-36 `sandbox exec` — run ONE command inside a sandbox box (typically a
 * test gate) and get the exit code + captured stdout/stderr back to the
 * HOST session, without moving the whole agent session into the box.
 *
 * Facet of the same story as the two other box paths. Boot-and-drive
 * (`session-spawn.ts`'s `bootSandboxAgentSession`) spawns the ENTIRE agent
 * in the box; `sandbox attach` (`sandbox-attach.ts`) hands out a durable
 * connection descriptor for driving the box's own daemon directly. Exec is
 * the lighter primitive in between: the host agent stays where it is and
 * calls out for a single command run (e.g. run the test suite in the box,
 * get its output into the host conversation).
 *
 * The exec capability itself is OPTIONAL on `BootedSandbox` (`exec?`,
 * `@agentproto/sandbox`) — providers shell into their own thing (e2b:
 * `sandbox.commands.run` + `CommandExitError`; other providers have no
 * implemented seam yet) and are expected to return a non-zero exit as a
 * RESULT, not a throw. This module is the tool layer only: resolve the
 * provider, procure the box handle (attach when `sandboxId` is given, an
 * EPHEMERAL box otherwise — always stopped at the end of the call, success
 * or failure, so a sandboxId-less exec never leaks a live box), run, then
 * truncate the streams for display before returning.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SandboxSpec } from "@agentproto/sandbox"
import { makeSandboxResolver, makeSandboxCredsStore } from "./sandbox-adapters.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import { recordSandboxBoot } from "./sandbox-ledger.js"

/** Per-stream display cap, in characters. Anything longer is cut to this
 *  many leading chars with a `…[truncated]` marker (the cap is generous —
 *  a green gate's stdout or a failing test's full report fits; a runaway
 *  `cat` of a binary database does not, and that's exactly the case the
 *  marker exists for). */
export const SANDBOX_EXEC_STREAM_MAX_CHARS = 20_000

/** Options for `execSandboxCommand` — the `sandbox_exec` MCP tool's input. */
export interface SandboxExecCommandChoices {
  /** Sandbox provider slug from `list_sandbox_providers` (e.g. "e2b", "box"). */
  provider: string
  /** Shell command to run inside the box (provider's SDK shells it verbatim). */
  command: string
  /**
   * Provider-assigned sandbox id to run against. REQUIRED-absent means
   * EPHEMERAL: boot a fresh box, run the command, then ALWAYS stop it
   * (success, non-zero exit, or failure) — an ephemeral exec never leaks.
   * With an id, the box is attached to and left exactly as found.
   */
  sandboxId?: string
  /** Absolute path INSIDE the box to run the command from (e.g. e2b's
   *  `/home/user`). Never a HOST path — a host path can never resolve in
   *  the box. */
  cwd?: string
  /** Extra env vars for THIS command only. */
  env?: Record<string, string>
  /** Per-command timeout, ms. Provider-dependent expiry error. */
  timeoutMs?: number
}

/** Successful exec's display shape — truncation is THIS layer's job. */
export interface SandboxExecOutput {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  sandboxId: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export type SandboxExecResult =
  | { ok: true; result: SandboxExecOutput }
  | {
      ok: false
      code:
        | "sandbox_provider_not_found"
        | "sandbox_no_exec"
        | "sandbox_exec_failed"
        | "sandbox_no_connect"
      message: string
    }

/** Cut one output stream to the display cap, telling the reader how much it lost. */
function truncateStream(stream: string): { text: string; truncated: boolean } {
  if (stream.length <= SANDBOX_EXEC_STREAM_MAX_CHARS) {
    return { text: stream, truncated: false }
  }
  return {
    text:
      stream.slice(0, SANDBOX_EXEC_STREAM_MAX_CHARS) +
      `\n…[truncated: ${stream.length} chars total, showing first ${SANDBOX_EXEC_STREAM_MAX_CHARS}]`,
    truncated: true,
  }
}

export interface ExecSandboxCommandOptions {
  /** Injectable resolver — defaults to the same creds-backed resolver
   *  `sandbox_attach` uses. Override for tests. */
  resolveSandboxProvider?: SandboxProviderResolver
}

/**
 * Run one command in a box. Resolution + procurement is the same shape as
 * `attachSandbox` (same resolver, env: {}); procurement differs on
 * `sandboxId` (attach — box left as found) vs not (boot — box ALWAYS
 * stopped, even on a failed exec or a missing-exec capability, since the
 * ephemeral box exists for nobody else). Teardown before error returns for
 * the ephemeral path, never after — stop() itself is best-effort there.
 */
export async function execSandboxCommand(
  opts: SandboxExecCommandChoices,
  deps: ExecSandboxCommandOptions = {},
): Promise<SandboxExecResult> {
  const resolver = deps.resolveSandboxProvider ?? makeSandboxResolver(makeSandboxCredsStore())
  const handle = await resolver(opts.provider)
  if (!handle) {
    return {
      ok: false,
      code: "sandbox_provider_not_found",
      message:
        `sandbox_exec: sandbox provider "${opts.provider}" not found. Check ` +
        "`list_sandbox_providers`, then `setup_sandbox_provider` if it needs credentials.",
    }
  }

  const spec: SandboxSpec = { provider: opts.provider, config: {} }

  // Procure the box. sandboxId given → attach (connect, never stop). None →
  // boot an ephemeral box and own its teardown for the rest of this call.
  let booted
  if (opts.sandboxId !== undefined) {
    if (!handle.provider.connect) {
      return {
        ok: false,
        code: "sandbox_no_connect",
        message:
          `sandbox_exec: provider "${opts.provider}" has no connect() — it can only ` +
          "boot fresh sandboxes, so sandboxId targeting is unavailable.",
      }
    }
    try {
      booted = await handle.provider.connect(opts.sandboxId, spec, { env: {} })
    } catch (err) {
      return {
        ok: false,
        code: "sandbox_exec_failed",
        message:
          `sandbox_exec: connect failed for provider "${opts.provider}" sandbox ` +
          `"${opts.sandboxId}" — ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    // The box was already there — stamp it connected (best-effort, never
    // throws; same rationale as attachSandbox).
    recordSandboxBoot({
      sandboxId: booted.sandboxId,
      provider: opts.provider,
      state: "connected",
    })
  } else {
    if (!handle.provider.boot) {
      return {
        ok: false,
        code: "sandbox_exec_failed",
        message: `sandbox_exec: provider "${opts.provider}" has no boot() — cannot procure an ephemeral box for the command.`,
      }
    }
    try {
      booted = await handle.provider.boot(spec, { env: {} })
    } catch (err) {
      return {
        ok: false,
        code: "sandbox_exec_failed",
        message:
          `sandbox_exec: boot failed for provider "${opts.provider}" — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Ephemeral ownership: whatever happens from here (missing exec
  // capability, throwing exec) the box is stopped before the return.
  const ephemeral = opts.sandboxId === undefined

  if (!booted.exec) {
    const message =
      `sandbox_exec: provider "${opts.provider}" does not support command exec ` +
      "— its sandbox has no exec() capability. Known provider implementations: e2b."
    if (ephemeral) await booted.stop().catch(() => undefined)
    return { ok: false, code: "sandbox_no_exec", message }
  }

  try {
    const result = await booted.exec({
      command: opts.command,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    const stdout = truncateStream(result.stdout)
    const stderr = truncateStream(result.stderr)
    return {
      ok: true,
      result: {
        exitCode: result.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: result.durationMs,
        sandboxId: booted.sandboxId,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      },
    }
  } catch (err) {
    return {
      ok: false,
      code: "sandbox_exec_failed",
      message:
        `sandbox_exec: command exec failed in sandbox "${booted.sandboxId}" on provider ` +
        `"${opts.provider}" — ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    if (ephemeral) await booted.stop().catch(() => undefined)
  }
}

export interface RegisterSandboxExecToolOptions {
  /** Same injection seam as `ExecSandboxCommandOptions.resolveSandboxProvider`
   *  — pass the daemon's shared resolver so this tool sees the same provider
   *  set as `list_sandbox_providers` / `agent_start.sandbox`. */
  resolveSandboxProvider?: SandboxProviderResolver
}

/** Register the `sandbox_exec` MCP tool. */
export function registerSandboxExecTool(
  server: McpServer,
  opts: RegisterSandboxExecToolOptions = {},
): void {
  server.tool(
    "sandbox_exec",
    "Run ONE command inside a sandbox box (typically a test gate) and return its exit " +
      "code plus captured stdout/stderr to the host session — without moving the whole " +
      "agent session into the box (that is `agent_start({ sandbox })`). Without " +
      "`sandboxId`, boots a fresh EPHEMERAL box, runs the command, then ALWAYS tears " +
      "it down, success or non-zero exit or failure. With `sandboxId`, attaches to the " +
      "existing box and leaves it exactly as found (never stops or pauses it). " +
      "`cwd` is absolute INSIDE the box, `env` applies to this command only, " +
      "`timeoutMs` caps the per-command wall clock. Output streams are truncated " +
      "with an explicit marker when oversized (each at " +
      `${SANDBOX_EXEC_STREAM_MAX_CHARS} chars). Use \`list_sandbox_providers\` to see ` +
      "available providers and `setup_sandbox_provider` to configure credentials first.",
    {
      provider: z.string().describe('Sandbox provider slug, e.g. "e2b" or "box".'),
      command: z.string().describe("Command to run inside the box, verbatim."),
      sandboxId: z
        .string()
        .optional()
        .describe(
          "Provider-assigned sandbox id to run against; omit for an EPHEMERAL box " +
            "(booted and torn down around the single command).",
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute path INSIDE the box to run the command from (e.g. e2b's `/home/user`); " +
            "never a host path.",
        ),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Extra env vars for THIS command only."),
      timeoutMs: z
        .number()
        .optional()
        .describe("Per-command timeout, ms (provider kills the process on expiry)."),
    },
    async input => {
      const result = await execSandboxCommand(
        {
          provider: input.provider,
          command: input.command,
          ...(input.sandboxId !== undefined ? { sandboxId: input.sandboxId } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.env !== undefined ? { env: input.env } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        opts.resolveSandboxProvider
          ? { resolveSandboxProvider: opts.resolveSandboxProvider }
          : {},
      )
      if (!result.ok) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: result.message, code: result.code }) },
          ],
          isError: true,
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.result) }],
      }
    },
  )
}
