/**
 * The vendor-client surface (AIP-66 Appendix A): start a Claude Code cloud
 * session under a PTY, send follow-ups headlessly, and preflight the
 * claude.ai login. The CLI is the only supported way to CREATE and PROMPT a
 * cloud session — the sessions API (sessions-api.ts) is observe-only.
 *
 * Every child process runs with ANTHROPIC_API_KEY and the Claude Code
 * gateway/redirect toggles deleted from its env (AIP-66 §8): a leftover
 * toggle or API key would make the CLI authenticate a different way and
 * refuse (or worse, re-route) the cloud call. The token the CLI reads from
 * the user's own login is never touched, logged or persisted here.
 *
 * The binary runner is injectable so tests can drive every path — auth
 * preflight, trust prompt, output parsing — from fixtures without a live
 * claude CLI or a real PTY.
 */

import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { ANTHROPIC_CORE_SCRUB_ENV } from "@agentproto/provider-presets"
import { toCliSessionId } from "./sessions-api.js"

// Cloud-provider redirect toggles scrubbed alongside ANTHROPIC_API_KEY —
// byte-for-byte the same set the claude-code adapter scrubs for gateway
// modes (adapters/claude-code/src/index.ts): a leftover Bedrock/Vertex/…
// toggle in the child env would override the claude.ai login path. The
// core ANTHROPIC_API_KEY entry comes from @agentproto/provider-presets, the
// single source of truth for that fact.
const CLAUDE_CODE_CLOUD_TOGGLES: readonly string[] = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
]

/** Env keys deleted from every claude child this adapter spawns (AIP-66 §8). */
export const CLAUDE_CODE_GATEWAY_ENV_UNSET: readonly string[] = [
  ...ANTHROPIC_CORE_SCRUB_ENV,
  ...CLAUDE_CODE_CLOUD_TOGGLES,
]

/** Copy `base` with every {@link CLAUDE_CODE_GATEWAY_ENV_UNSET} key deleted. */
export function cloudChildEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  const drop = new Set(CLAUDE_CODE_GATEWAY_ENV_UNSET)
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || drop.has(key)) continue
    out[key] = value
  }
  return out
}

// ── injectable runner ───────────────────────────────────────────────────────

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOpts {
  cwd: string
  env: Record<string, string>
  timeoutMs?: number
  /** "ignore" detaches stdin so a non-interactive call can never TTY-block. */
  stdin?: "ignore"
}

export interface PtyHandle {
  write(data: string): void
  result: Promise<{ code: number; output: string }>
}

export interface PtyRunOpts extends RunOpts {
  onData?: (chunk: string) => void
}

/** What {@link startCloudSession} / {@link sendPrompt} drive. Tests inject a
 *  fake; production uses {@link defaultCloudCliRunner}. */
export interface CloudCliRunner {
  run(cmd: string, args: string[], opts: RunOpts): Promise<RunResult>
  runPty(cmd: string, args: string[], opts: PtyRunOpts): PtyHandle
}

const DEFAULT_RUN_TIMEOUT_MS = 60_000

/** Real runner: child_process for headless calls, node-pty (optional dep)
 *  for the TTY-required `claude --cloud` start. */
export function defaultCloudCliRunner(): CloudCliRunner {
  return {
    run(cmd, args, opts) {
      return new Promise<RunResult>((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: [opts.stdin === "ignore" ? "ignore" : "inherit", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          reject(
            new Error(
              `claude code cloud: \`${cmd} ${args.join(" ")}\` timed out after ` +
                `${opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms`,
            ),
          )
        }, opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
        timer.unref?.()
        child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()))
        child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()))
        child.on("error", (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          resolve({ code: code ?? -1, stdout, stderr })
        })
      })
    },
    runPty(cmd, args, opts) {
      let resolveResult: (v: { code: number; output: string }) => void
      let rejectResult: (err: unknown) => void
      const result = new Promise<{ code: number; output: string }>((res, rej) => {
        resolveResult = res
        rejectResult = rej
      })
      let proc: import("node-pty").IPty | null = null
      const pendingWrites: string[] = []
      // node-pty is an optional native dep (same policy as @agentproto/cli):
      // load it lazily and fail with an actionable message when absent.
      void import("node-pty")
        .then(mod => {
          // node-pty is CJS — `import()` wraps it under `.default`.
          const pty = (mod as { default?: { spawn: typeof import("node-pty").spawn } }).default ?? (mod as unknown as { spawn: typeof import("node-pty").spawn })
          if (typeof pty.spawn !== "function") throw new Error("node-pty has no spawn")
          const p = pty.spawn(cmd, args, {
            name: "xterm-256color",
            cols: 120,
            rows: 40,
            cwd: opts.cwd,
            env: opts.env,
          })
          proc = p
          for (const data of pendingWrites) p.write(data)
          pendingWrites.length = 0
          let output = ""
          let answeredTrustPrompt = false
          p.onData((chunk: string) => {
            output += chunk
            opts.onData?.(chunk)
            // First run in a folder shows a trust prompt whose DEFAULT
            // highlighted option is "No, exit" — Down + Enter picks
            // "Yes, I trust this folder". Answer at most once.
            if (!answeredTrustPrompt && /Yes, I trust this folder/.test(output)) {
              answeredTrustPrompt = true
              p.write("\x1b[B\r")
            }
          })
          const timer = setTimeout(() => {
            try {
              p.kill("SIGKILL")
            } catch {
              // already dead
            }
            rejectResult(
              new Error(
                `claude code cloud: \`${cmd} ${args.join(" ")}\` timed out after ` +
                  `${opts.timeoutMs ?? 120_000}ms under the PTY`,
              ),
            )
          }, opts.timeoutMs ?? 120_000)
          timer.unref?.()
          p.onExit(({ exitCode }: { exitCode: number }) => {
            clearTimeout(timer)
            resolveResult({ code: exitCode, output })
          })
        })
        .catch(err => {
          rejectResult(
            new Error(
              `claude code cloud: \`claude --cloud\` needs a real PTY and ` +
                `node-pty is not available (${err instanceof Error ? err.message : String(err)}) — ` +
                `install it (npm i node-pty) to use managed cloud sessions`,
            ),
          )
        })
      return {
        write: (data: string) => {
          if (proc) proc.write(data)
          else pendingWrites.push(data)
        },
        result,
      }
    },
  }
}

// ── login refresh ───────────────────────────────────────────────────────────

export interface RefreshLoginOpts {
  runner?: CloudCliRunner
  env?: Record<string, string | undefined>
  /** Default os.tmpdir(): the refresh must not depend on any repo checkout. */
  cwd?: string
  /** Default 60s. */
  timeoutMs?: number
}

/**
 * Build the injectable login-refresh trigger. Running a trivial headless
 * prompt (`claude -p "Reply OK" --model haiku`) is what makes the claude CLI
 * re-mint and re-write the OAuth access token to the keychain (verified
 * live: `claude auth status` does NOT refresh it). stdin is detached, the
 * child runs from {@link os.tmpdir} with the same scrubbed env every other
 * claude child gets, and its stdout/stderr are never read or logged — they
 * can carry token-adjacent material and must not leak.
 *
 * Concurrent callers share one in-flight refresh (a single promise), so a
 * burst of requests around expiry runs the CLI at most once.
 */
export function createRefreshLogin(
  opts: RefreshLoginOpts = {},
): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  return () => {
    if (inFlight) return inFlight
    const run = (async () => {
      const runner = opts.runner ?? defaultCloudCliRunner()
      const env = cloudChildEnv(opts.env ?? process.env)
      let result: RunResult
      try {
        result = await runner.run(
          "claude",
          ["-p", "Reply OK", "--model", "haiku"],
          {
            cwd: opts.cwd ?? tmpdir(),
            env,
            stdin: "ignore",
            timeoutMs: opts.timeoutMs ?? 60_000,
          },
        )
      } catch (err) {
        throw new Error(
          "claude code cloud: could not refresh the claude.ai login — is " +
            `the claude CLI installed and on PATH? (${err instanceof Error ? err.message : String(err)})`,
        )
      }
      if (result.code !== 0) {
        // Never surface stdout/stderr: the refresh child may print
        // token-adjacent output that must not enter a log.
        throw new Error(
          "claude code cloud: could not refresh the claude.ai login " +
            `(exit ${result.code}) — run \`claude auth login\``,
        )
      }
    })()
    const wrapped = run.finally(() => {
      if (inFlight === wrapped) inFlight = null
    })
    inFlight = wrapped
    return wrapped
  }
}

// ── auth preflight ──────────────────────────────────────────────────────────

export interface AuthStatus {
  loggedIn: boolean
  authMethod?: string
}

/** Parse `claude auth status` JSON output. */
export function parseAuthStatus(stdout: string): AuthStatus {
  const trimmed = stdout.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "claude code cloud: could not parse `claude auth status` output — " +
        "run `claude auth login`",
    )
  }
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
    loggedIn?: boolean
    authMethod?: string
  }
  return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod }
}

/**
 * Refuse the spawn before any side effect when the claude CLI is missing,
 * not logged in, or authenticated by API key — cloud sessions require a
 * claude.ai sign-in (verified live: an ANTHROPIC_API_KEY env makes the CLI
 * refuse with "Cloud sessions need a claude.ai sign-in").
 */
export async function preflightAuth(
  runner: CloudCliRunner,
  opts: { cwd: string; env: Record<string, string> },
): Promise<AuthStatus> {
  let result: RunResult
  try {
    result = await runner.run("claude", ["auth", "status"], {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: 15_000,
      stdin: "ignore",
    })
  } catch (err) {
    throw new Error(
      `claude code cloud: could not run \`claude auth status\` — is the ` +
        `claude CLI installed and on PATH? (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(
      "claude code cloud: `claude auth status` failed — the claude CLI is " +
        "not usable; run `claude auth login`",
    )
  }
  const status = parseAuthStatus(result.stdout)
  if (!status.loggedIn) {
    throw new Error(
      "claude code cloud: not logged in — cloud sessions need a claude.ai " +
        "sign-in; run `claude auth login`",
    )
  }
  if (status.authMethod === "api_key") {
    throw new Error(
      "claude code cloud: authenticated by API key — cloud sessions need a " +
        "claude.ai sign-in; run `claude auth login`",
    )
  }
  return status
}

// ── start / send ────────────────────────────────────────────────────────────

export interface StartedCloudSession {
  /** CLI-spelled id (`session_<id>`), ready for `--cloud` / `--teleport`. */
  sessionId: string
  url: string
  title?: string
}

/** Parse the `claude --cloud` start transcript: the id from the "Resume
 *  with:" line (falling back to the View URL's path), the URL, and the
 *  session title. Returns null when no session id can be found. */
export function parseCloudStartOutput(
  output: string,
): StartedCloudSession | null {
  let sessionId: string | undefined
  let url: string | undefined
  let title: string | undefined

  const resume = output.match(/Resume with:\s*claude\s+--teleport\s+(session_[A-Za-z0-9_-]+)/)
  if (resume?.[1]) sessionId = resume[1]

  const view = output.match(/View:\s*(https?:\/\/\S+)/)
  if (view?.[1]) {
    url = view[1]
    if (!sessionId) {
      const fromUrl = url.match(/\/session_([A-Za-z0-9_-]+)/)
      if (fromUrl?.[1]) sessionId = `session_${fromUrl[1]}`
    }
  }

  const created = output.match(/Created cloud session:\s*(.+)/)
  if (created?.[1]) title = created[1].trim()

  if (!sessionId) return null
  return {
    sessionId,
    url: url ?? `https://claude.ai/code/${sessionId}`,
    ...(title ? { title } : {}),
  }
}

export interface StartCloudSessionOpts {
  runner?: CloudCliRunner
  env?: Record<string, string | undefined>
  cwd: string
  /** Hard cap on the interactive start (PTY) — default 120s. */
  timeoutMs?: number
  /** Skip the auth preflight (tests only; production always preflights). */
  skipPreflight?: boolean
}

/**
 * Start a cloud session: `claude --cloud "<prompt>"` under a PTY (the CLI
 * requires a TTY here), answering the first-run folder-trust prompt, then
 * parse the printed session id / URL and exit. The vendor runs the first
 * turn; observe it via the sessions API.
 */
export async function startCloudSession(
  prompt: string,
  opts: StartCloudSessionOpts,
): Promise<StartedCloudSession> {
  const runner = opts.runner ?? defaultCloudCliRunner()
  const env = cloudChildEnv(opts.env ?? process.env)
  if (!opts.skipPreflight) await preflightAuth(runner, { cwd: opts.cwd, env })

  const pty = runner.runPty("claude", ["--cloud", prompt], {
    cwd: opts.cwd,
    env,
    timeoutMs: opts.timeoutMs ?? 120_000,
  })
  const { code, output } = await pty.result
  if (code !== 0) {
    throw new Error(
      `claude code cloud: \`claude --cloud\` exited ${code}: ` +
        `${output.trim().split("\n").slice(-5).join("\n").trim()}`,
    )
  }
  const started = parseCloudStartOutput(output)
  if (!started) {
    throw new Error(
      "claude code cloud: could not parse a cloud session id from " +
        "`claude --cloud` output",
    )
  }
  return started
}

export interface SendPromptOpts {
  runner?: CloudCliRunner
  env?: Record<string, string | undefined>
  cwd: string
  timeoutMs?: number
  skipPreflight?: boolean
}

/**
 * Send a follow-up turn: `claude -p "<text>" --cloud <session id>` with
 * stdin detached (no TTY). Send-only by design — the CLI prints "Sent to
 * cloud session." and never the reply; the reply is observed via the
 * sessions API. Accepts `session_`/`cse_` ids.
 */
export async function sendPrompt(
  sessionId: string,
  text: string,
  opts: SendPromptOpts,
): Promise<{ stdout: string }> {
  const runner = opts.runner ?? defaultCloudCliRunner()
  const env = cloudChildEnv(opts.env ?? process.env)
  if (!opts.skipPreflight) await preflightAuth(runner, { cwd: opts.cwd, env })

  const result = await runner.run(
    "claude",
    ["-p", text, "--cloud", toCliSessionId(sessionId)],
    {
      cwd: opts.cwd,
      env,
      stdin: "ignore",
      timeoutMs: opts.timeoutMs ?? 60_000,
    },
  )
  if (result.code !== 0) {
    throw new Error(
      `claude code cloud: \`claude -p --cloud\` exited ${result.code}: ` +
        `${(result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n").trim()}`,
    )
  }
  return { stdout: result.stdout }
}
