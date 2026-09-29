/**
 * Adapter-death signals in a session's harvested output.
 *
 * A workflow run can reach `status=done` while the adapter inside the
 * sandbox box was OOM-killed mid-turn (live on agentproto/ts#1597: the box
 * session's tail read `[error] ACP connection closed` then `Killed`, the run
 * still reported done, and the lane looked green with no review posted).
 * The driver uses this to downgrade such a run to a failure so the calling
 * job's fallback reviewer takes over instead of passing blind.
 */

const ADAPTER_CRASH_PATTERNS = [
  { re: /\[error\][^\n]*ACP connection closed/, label: "ACP connection closed" },
  { re: /^[ \t]*Killed[ \t]*$/m, label: "process Killed (SIGKILL, typically OOM)" },
  { re: /ended with status 'error'/, label: "session ended with status 'error'" },
]

/**
 * Return the labels of every crash signal found in `text` (empty when none).
 * Pure: no I/O, no logging.
 */
export function detectAdapterCrash(text) {
  if (typeof text !== "string" || text.length === 0) return []
  const hits = []
  for (const { re, label } of ADAPTER_CRASH_PATTERNS) {
    if (re.test(text)) hits.push(label)
  }
  return hits
}
