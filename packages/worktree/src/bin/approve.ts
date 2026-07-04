import { closeSync, createReadStream, createWriteStream, openSync } from "node:fs"
import { createInterface } from "node:readline"
import type { ApprovalRequest } from "@agentproto/workflow-runtime"

/** True when `/dev/tty` can be opened — i.e. a real terminal is attached. */
export function hasTty(): boolean {
  try {
    const fd = openSync("/dev/tty", "r+")
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

/** Prompt on `/dev/tty` (not stdin/stdout, which may be piping the workflow's own IO). */
export async function askTty(prompt: string): Promise<string> {
  const input = createReadStream("/dev/tty")
  const output = createWriteStream("/dev/tty")
  const rl = createInterface({ input, output })
  try {
    return await new Promise<string>((resolvePromise) => rl.question(prompt, resolvePromise))
  } finally {
    rl.close()
    input.destroy()
    output.destroy()
  }
}

export interface ApproveDeps {
  hasTty?: () => boolean
  ask?: (prompt: string) => Promise<string>
}

/**
 * Build the workflow's `approve` callback: `--yes` auto-approves; otherwise a
 * y/n prompt on `/dev/tty`; with no TTY attached (non-interactive), don't
 * approve — the worktree is left in place rather than silently cleaned up.
 */
export function makeApprove(
  opts: { yes: boolean },
  deps: ApproveDeps = {},
): (req: ApprovalRequest) => Promise<boolean> {
  const hasTtyFn = deps.hasTty ?? hasTty
  const askFn = deps.ask ?? askTty
  return async (req: ApprovalRequest): Promise<boolean> => {
    if (opts.yes) {
      process.stderr.write(`${req.prompt} — auto-approved (--yes)\n`)
      return true
    }
    if (!hasTtyFn()) {
      process.stderr.write(`${req.prompt} — no TTY attached, not approving (worktree left in place)\n`)
      return false
    }
    const answer = await askFn(`${req.prompt} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  }
}
