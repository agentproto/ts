import { spawn } from "node:child_process"

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Run an argv (no shell — args pass through verbatim, no injection risk). */
export function execArgv(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")))
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }))
  })
}

/**
 * Run a single command string through a shell. Callers pass `depsCmd` /
 * `gateCmd` as a trusted, developer-authored config value (the same trust
 * model as a CI job's `script:` line) — not untrusted end-user input.
 */
export function execShell(cmd: string, cwd: string): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, { cwd, shell: true, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")))
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }))
  })
}

export async function execGit(repoRoot: string, args: readonly string[]): Promise<ExecResult> {
  const result = await execArgv("git", ["-C", repoRoot, ...args], repoRoot)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  }
  return result
}
