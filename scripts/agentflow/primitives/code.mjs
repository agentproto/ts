/**
 * code primitive — the read-write ACTOR.
 *
 * Drives the Claude Code CLI with edit permissions to mutate the working tree
 * toward a goal. Carries a session (`--session-id` on the first call, then
 * `--resume`) so a multi-round fixer remembers its prior attempts — the
 * "conversation + changes timeline." Unlike the `review` primitive (which stays
 * fresh for independence), the actor BENEFITS from continuity.
 *
 * "fix" is not its own thing — it's `code` with a goal derived from review
 * findings. "write a changeset" is `code` with a different goal. Etc.
 *
 * Local engine only: the actor needs the CLI's edit tools. Cloud acting lives
 * in CI's apply-review.mjs (an API tool-loop).
 */

import { spawnSync } from 'node:child_process'

export function runCode({
  goal,
  sessionId,
  resume = false,
  engine = 'local',
  claudeBin = 'claude',
  root,
  allowedTools = ['Edit', 'Read', 'Grep'],
}) {
  if (engine !== 'local') {
    throw new Error(
      '[agentflow] code primitive: only engine "local" is supported ' +
        '(cloud acting → CI apply-review.mjs).',
    )
  }
  const args = ['-p', goal, '--permission-mode', 'acceptEdits', '--allowedTools', ...allowedTools]
  if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId)
  const res = spawnSync(claudeBin, args, { cwd: root, stdio: 'inherit' })
  return { ok: res.status === 0, sessionId }
}
