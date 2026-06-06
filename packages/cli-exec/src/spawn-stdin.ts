import { spawn } from "node:child_process"

export interface SpawnWithStdinOptions {
  /** Executable to invoke (must be on PATH). */
  readonly command: string
  /** Static argv. The prompt is fed over stdin, not as an argument. */
  readonly args?: readonly string[]
  /** Text written to the child's stdin, then closed. */
  readonly stdin: string
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string
  /** Hard timeout in ms; the child is killed and the call rejects. Default 90000. */
  readonly timeoutMs?: number
  /** Abort the call — kills the child and rejects. */
  readonly signal?: AbortSignal
  /** Signal used to kill on timeout/abort. Default "SIGTERM". */
  readonly killSignal?: NodeJS.Signals
}

/**
 * Spawn a command in one-shot mode: write `stdin`, close it, capture stdout.
 *
 * Resolves with captured stdout on exit code 0; rejects on non-zero exit (with
 * trimmed stderr), spawn error, timeout, or abort. A single settle guard makes
 * the late `close` event after a kill a no-op.
 */
export function spawnWithStdin(opts: SpawnWithStdinOptions): Promise<string> {
  const {
    command,
    args = [],
    stdin,
    cwd,
    timeoutMs = 90_000,
    signal,
    killSignal = "SIGTERM",
  } = opts

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${command} aborted before start`))
      return
    }

    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    })

    let out = ""
    let err = ""
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      fn()
    }

    const onAbort = () => {
      child.kill(killSignal)
      finish(() => reject(new Error(`${command} aborted`)))
    }
    const timer = setTimeout(() => {
      child.kill(killSignal)
      finish(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    signal?.addEventListener("abort", onAbort)

    child.stdout.on("data", d => (out += d))
    child.stderr.on("data", d => (err += d))
    child.on("error", e =>
      finish(() => reject(new Error(`${command} not runnable: ${e.message}`)))
    )
    child.on("close", code =>
      finish(() => {
        if (code === 0) resolve(out)
        else
          reject(
            new Error(`${command} exited with code ${code}: ${err.trim().slice(0, 200) || "(no stderr)"}`)
          )
      })
    )

    // child may exit before stdin drains → EPIPE on the stream; the close
    // handler already drives resolve/reject, so this write error is benign
    child.stdin.on("error", () => {})
    child.stdin.write(stdin)
    child.stdin.end()
  })
}
