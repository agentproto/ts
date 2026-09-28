import { spawn, type ChildProcess } from "node:child_process"

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Extra `AGENTPROTO_*` (or any) vars, merged onto `process.env` for the child. */
export interface ExecOptions {
  env?: Record<string, string>
  /**
   * Cancels the child. When given, the child is spawned as the leader of its
   * own process group (POSIX), and an abort signals the WHOLE group, so a
   * `sh -c "pnpm install"` takes its `pnpm` and every worker underneath it
   * down too instead of orphaning them. SIGTERM first, SIGKILL after
   * {@link killGraceMs}. Already-aborted signals reject before spawning.
   * The promise still resolves (with the child's real exit code) once the
   * tree is gone; callers decide what an aborted run means.
   */
  signal?: AbortSignal
  /** Grace between SIGTERM and SIGKILL on abort. Default 5000ms. */
  killGraceMs?: number
}

/** Merge caller-supplied vars onto the inherited env (caller wins). */
function mergedEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return extra ? { ...process.env, ...extra } : process.env
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error("aborted")
}

/** Signal a child's whole process group (POSIX), else just the child. */
function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill(sig)
    else process.kill(-child.pid, sig)
  } catch {
    // Group already gone.
  }
}

/** Wire `opts.signal` to a tree-kill of `child`; returns the detach fn. */
function killOnAbort(child: ChildProcess, opts: ExecOptions): () => void {
  const { signal } = opts
  if (!signal) return () => {}
  let escalation: NodeJS.Timeout | undefined
  const onAbort = (): void => {
    signalTree(child, "SIGTERM")
    escalation = setTimeout(() => signalTree(child, "SIGKILL"), opts.killGraceMs ?? 5000)
    escalation.unref()
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })
  return () => {
    signal.removeEventListener("abort", onAbort)
    // The leader is dead but a stubborn grandchild may not be: let the
    // escalation fire rather than cancelling it, so nothing outlives an abort.
    if (escalation && !signal.aborted) clearTimeout(escalation)
  }
}

/** Run an argv (no shell — args pass through verbatim, no injection risk). */
export function execArgv(
  command: string,
  args: readonly string[],
  cwd: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) return reject(abortReason(opts.signal))
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: mergedEnv(opts.env),
      detached: opts.signal !== undefined && process.platform !== "win32",
    })
    const detach = killOnAbort(child, opts)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")))
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")))
    child.on("error", (err) => {
      detach()
      reject(err)
    })
    child.on("close", (code) => {
      detach()
      resolvePromise({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Run a single command string through a shell. Callers pass `depsCmd` /
 * `gateCmd` / a config `setup` line as a trusted, developer-authored value
 * (the same trust model as a CI job's `script:` line) — not untrusted
 * end-user input. `opts.env` layers `AGENTPROTO_*` vars onto the child.
 */
export function execShell(cmd: string, cwd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) return reject(abortReason(opts.signal))
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: mergedEnv(opts.env),
      detached: opts.signal !== undefined && process.platform !== "win32",
    })
    const detach = killOnAbort(child, opts)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")))
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")))
    child.on("error", (err) => {
      detach()
      reject(err)
    })
    child.on("close", (code) => {
      detach()
      resolvePromise({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

export async function execGit(repoRoot: string, args: readonly string[]): Promise<ExecResult> {
  // `repoRoot` is the main repo root (resolved via --git-common-dir upstream),
  // which always exists — so it's a safe spawn cwd even mid-archive, when the
  // worktree being torn down has already been removed.
  const result = await execArgv("git", ["-C", repoRoot, ...args], repoRoot)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  }
  return result
}
