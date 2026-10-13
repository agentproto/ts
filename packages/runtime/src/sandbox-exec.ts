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
import { scrubCommandFromMessage } from "@agentproto/sandbox"
import { makeSandboxResolver, makeSandboxCredsStore } from "./sandbox-adapters.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import { recordSandboxBoot } from "./sandbox-ledger.js"
import { isDeviceSandboxTarget } from "./sandbox-providers/device.js"
import {
  makeRedactor,
  resolveEnvProfiles,
  secretishLiteralValues,
  validateEnvProfiles,
  type EnvProfilesDeps,
} from "./sandbox-exec-env-profiles.js"

/** Per-stream display cap, in characters. Anything longer is cut to this
 *  many leading chars with a `…[truncated]` marker (the cap is generous —
 *  a green gate's stdout or a failing test's full report fits; a runaway
 *  `cat` of a binary database does not, and that's exactly the case the
 *  marker exists for). */
export const SANDBOX_EXEC_STREAM_MAX_CHARS = 20_000

/** Command text ceiling, bytes. E2B rejects a ~30 KB inline command with an opaque
 *  `[invalid_argument] error starting process`; 16 KB stays well under that. */
export const SANDBOX_EXEC_MAX_COMMAND_BYTES = 16 * 1024
/** Total env ceiling (names + values), bytes — same conservative reasoning. */
export const SANDBOX_EXEC_MAX_ENV_BYTES = 32 * 1024
/** Per-file / file-count ceilings for the `files` upload. */
export const SANDBOX_EXEC_MAX_FILE_BYTES = 25 * 1024 * 1024
export const SANDBOX_EXEC_MAX_FILES = 32

/** One file written into the box before the command runs. */
export interface SandboxExecFile {
  /** Absolute path INSIDE the box. Parent directories are created. */
  path: string
  /** File content, interpreted per `encoding`. */
  content: string
  /** `utf8` (default) or `base64` for binary content. */
  encoding?: "utf8" | "base64"
}

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
  /** Extra env vars for THIS command only. Literal values: anything the caller
   *  puts here is visible in its own context — prefer `envProfiles` for secrets. */
  env?: Record<string, string>
  /**
   * `ENV_NAME → auth profile id`: the daemon reads that profile's credential
   * (keychain, or its sub-account provider) and sets it as `ENV_NAME` in the
   * command's env, so the caller never holds the value. The caller names a
   * PROFILE, never a keychain ref. Same var in `env` too → rejected.
   */
  envProfiles?: Record<string, string>
  /** Files written into the box before the command runs (instead of inlining
   *  a large script in `command`). */
  files?: SandboxExecFile[]
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
        | "sandbox_exec_invalid_input"
        | "sandbox_exec_env_profile"
        | "sandbox_exec_too_large"
        | "sandbox_no_write_file"
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

export interface ExecSandboxCommandOptions extends EnvProfilesDeps {
  /** Injectable resolver — defaults to the same creds-backed resolver
   *  `sandbox_attach` uses. Override for tests. */
  resolveSandboxProvider?: SandboxProviderResolver
}

const kb = (bytes: number): string => `${Math.ceil(bytes / 1024)} KB`

/** Validate `files` and decode them to bytes. Error string on bad input. */
function decodeFiles(
  files: readonly SandboxExecFile[],
): { ok: true; files: { path: string; data: Uint8Array }[] } | { ok: false; message: string } {
  if (files.length > SANDBOX_EXEC_MAX_FILES) {
    return { ok: false, message: `sandbox_exec: ${files.length} files exceeds the limit of ${SANDBOX_EXEC_MAX_FILES}.` }
  }
  const out: { path: string; data: Uint8Array }[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (!f.path.startsWith("/") || f.path.includes("\0")) {
      return { ok: false, message: `sandbox_exec: file path "${f.path}" must be an absolute path INSIDE the box.` }
    }
    if (seen.has(f.path)) {
      return { ok: false, message: `sandbox_exec: file path "${f.path}" is listed twice.` }
    }
    seen.add(f.path)
    let data: Buffer
    if (f.encoding === "base64") {
      const compact = f.content.replace(/\s+/g, "")
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
        return { ok: false, message: `sandbox_exec: file "${f.path}" is not valid base64.` }
      }
      data = Buffer.from(compact, "base64")
    } else {
      data = Buffer.from(f.content, "utf8")
    }
    if (data.byteLength > SANDBOX_EXEC_MAX_FILE_BYTES) {
      return {
        ok: false,
        message: `sandbox_exec: file "${f.path}" is ${kb(data.byteLength)}, over the ${kb(SANDBOX_EXEC_MAX_FILE_BYTES)} limit.`,
      }
    }
    out.push({ path: f.path, data })
  }
  return { ok: true, files: out }
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
  const invalid = (message: string): SandboxExecResult => ({
    ok: false,
    code: "sandbox_exec_invalid_input",
    message: `sandbox_exec: ${message}`,
  })

  // Input checks that need no I/O run first, so a bad call never touches a
  // keychain or boots a box.
  const envProfiles = opts.envProfiles !== undefined && Object.keys(opts.envProfiles).length > 0 ? opts.envProfiles : undefined
  if (envProfiles !== undefined) {
    const problem = validateEnvProfiles(envProfiles, opts.env)
    if (problem !== undefined) return invalid(problem)
    if (isDeviceSandboxTarget(opts.provider)) {
      return invalid(
        "envProfiles are not supported on device targets — the box is another machine and " +
          "keychain-backed credentials never leave this one.",
      )
    }
  }
  const commandBytes = Buffer.byteLength(opts.command, "utf8")
  if (commandBytes > SANDBOX_EXEC_MAX_COMMAND_BYTES) {
    return {
      ok: false,
      code: "sandbox_exec_too_large",
      message:
        `sandbox_exec: command is ${kb(commandBytes)}, over the ${kb(SANDBOX_EXEC_MAX_COMMAND_BYTES)} limit — ` +
        "upload the script as a file (`files: [{ path, content }]`) and run it by path, or pass the payload via env.",
    }
  }
  let files: { path: string; data: Uint8Array }[] = []
  if (opts.files !== undefined && opts.files.length > 0) {
    const decoded = decodeFiles(opts.files)
    if (!decoded.ok) return invalid(decoded.message.replace(/^sandbox_exec: /, ""))
    files = decoded.files
  }

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

  // Resolve profile-backed env AFTER the provider is known to exist. Values
  // live only in `env` (the provider's exec env) and the redactor below.
  let env = opts.env
  const secretValues = secretishLiteralValues(opts.env)
  if (envProfiles !== undefined) {
    const resolved = await resolveEnvProfiles(envProfiles, opts.env, deps)
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.code === "invalid_input" ? "sandbox_exec_invalid_input" : "sandbox_exec_env_profile",
        message: `sandbox_exec: ${resolved.message}`,
      }
    }
    env = { ...opts.env, ...resolved.env }
    secretValues.push(...resolved.secretValues)
  }
  const redact = makeRedactor(secretValues)
  // Provider/SDK error text: strip the echoed command, drop secrets, cap length.
  const sanitize = (message: string): string => {
    const cleaned = redact(scrubCommandFromMessage(message, opts.command))
    const capped = cleaned.length > 2_000 ? `${cleaned.slice(0, 2_000)}…(${cleaned.length} chars)` : cleaned
    return /invalid_argument/.test(capped)
      ? `${capped} (the provider rejected the request — if the command or env is large, upload scripts via \`files\`)`
      : capped
  }

  if (env !== undefined) {
    let envBytes = 0
    let largest: { name: string; bytes: number } | undefined
    for (const [name, value] of Object.entries(env)) {
      const bytes = Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 2
      envBytes += bytes
      if (largest === undefined || bytes > largest.bytes) largest = { name, bytes }
    }
    if (envBytes > SANDBOX_EXEC_MAX_ENV_BYTES) {
      return {
        ok: false,
        code: "sandbox_exec_too_large",
        message:
          `sandbox_exec: env is ${kb(envBytes)} in total, over the ${kb(SANDBOX_EXEC_MAX_ENV_BYTES)} limit` +
          (largest ? ` (largest: ${largest.name}, ${kb(largest.bytes)})` : "") +
          " — upload large payloads as files (`files: [{ path, content }]`) instead of env.",
      }
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
        message: sanitize(
          `sandbox_exec: connect failed for provider "${opts.provider}" sandbox ` +
            `"${opts.sandboxId}" — ${err instanceof Error ? err.message : String(err)}`,
        ),
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
        message: sanitize(
          `sandbox_exec: boot failed for provider "${opts.provider}" — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        ),
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
  if (files.length > 0 && !booted.writeFile) {
    if (ephemeral) await booted.stop().catch(() => undefined)
    return {
      ok: false,
      code: "sandbox_no_write_file",
      message:
        `sandbox_exec: provider "${opts.provider}" cannot upload files — its sandbox has no ` +
        "writeFile() capability. Known provider implementations: e2b.",
    }
  }

  try {
    for (const f of files) {
      try {
        await booted.writeFile!(f.path, f.data)
      } catch (err) {
        return {
          ok: false,
          code: "sandbox_exec_failed",
          message: sanitize(
            `sandbox_exec: writing file "${f.path}" into sandbox "${booted.sandboxId}" failed — ` +
              `${err instanceof Error ? err.message : String(err)}`,
          ),
        }
      }
    }
    const result = await booted.exec({
      command: opts.command,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    // Redact BEFORE truncating, so a secret straddling the cut isn't half-shown.
    const stdout = truncateStream(redact(result.stdout))
    const stderr = truncateStream(redact(result.stderr))
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
      message: sanitize(
        `sandbox_exec: command exec failed in sandbox "${booted.sandboxId}" on provider ` +
          `"${opts.provider}" — ${err instanceof Error ? err.message : String(err)}`,
      ),
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
  /** Test seams for `envProfiles` resolution (profile lookup, keychain, sub-account). */
  envProfiles?: EnvProfilesDeps
}

/** Input shape shared by the MCP tool and the daemon's `POST /sandboxes/exec`. */
export const sandboxExecInputShape = {
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
    .describe(
      "Extra env vars for THIS command only (literal values — they pass through your own " +
        "context; use `envProfiles` for secrets).",
    ),
  envProfiles: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Secrets WITHOUT holding them: { "ENV_NAME": "<auth profile id>" }. The daemon reads ' +
        "that profile's credential and sets it as ENV_NAME in the command's env; the value " +
        "never enters your context, the result, or argv. Name a PROFILE id (see " +
        "`auth_profile_list`), never a keychain ref. Disabled/unknown profiles and ENV_NAMEs " +
        "also present in `env` are rejected. Not supported on device targets.",
    ),
  files: z
    .array(
      z.object({
        path: z.string().describe("Absolute path INSIDE the box; parent dirs are created."),
        content: z.string().describe("File content (utf8, or base64 per `encoding`)."),
        encoding: z.enum(["utf8", "base64"]).optional(),
      }),
    )
    .optional()
    .describe(
      "Files written into the box BEFORE the command runs — use instead of inlining a large " +
        `script in \`command\` (commands over ${SANDBOX_EXEC_MAX_COMMAND_BYTES / 1024} KB are rejected).`,
    ),
  timeoutMs: z
    .number()
    .optional()
    .describe(
      "Per-command timeout, ms (provider kills the process on expiry). Omit to let the " +
        "command run as long as the box lives.",
    ),
}
export const sandboxExecInputSchema = z.object(sandboxExecInputShape)

/** Zod-parsed input → the function's choices (drops absent optionals). */
export function sandboxExecChoicesFromInput(
  input: z.infer<typeof sandboxExecInputSchema>,
): SandboxExecCommandChoices {
  return {
    provider: input.provider,
    command: input.command,
    ...(input.sandboxId !== undefined ? { sandboxId: input.sandboxId } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.envProfiles !== undefined ? { envProfiles: input.envProfiles } : {}),
    ...(input.files !== undefined
      ? {
          files: input.files.map(f => ({
            path: f.path,
            content: f.content,
            ...(f.encoding !== undefined ? { encoding: f.encoding } : {}),
          })),
        }
      : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  }
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
      "`cwd` is absolute INSIDE the box, `env` applies to this command only (use " +
      "`envProfiles` to inject a stored credential by auth profile id without ever seeing it; " +
      "use `files` to ship a large script instead of inlining it), " +
      "`timeoutMs` caps the per-command wall clock. Output streams are truncated " +
      "with an explicit marker when oversized (each at " +
      `${SANDBOX_EXEC_STREAM_MAX_CHARS} chars); resolved secrets are redacted from output and ` +
      "errors, and errors show at most 200 chars of the command. Use `list_sandbox_providers` to see " +
      "available providers and `setup_sandbox_provider` to configure credentials first.",
    sandboxExecInputShape,
    async input => {
      const result = await execSandboxCommand(
        sandboxExecChoicesFromInput(input),
        {
          ...(opts.resolveSandboxProvider ? { resolveSandboxProvider: opts.resolveSandboxProvider } : {}),
          ...opts.envProfiles,
        },
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
