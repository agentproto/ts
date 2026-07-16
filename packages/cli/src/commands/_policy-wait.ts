/**
 * Long-poll `GET /policies/:id/wait` — the shared loop behind both
 * `agentproto sessions wait --policy <id>` and `agentproto policy wait
 * <id>`. Deliberately its own module rather than living in
 * `_daemon-helpers.ts`: it needs an EXTERNAL import of `httpGetJson` (not a
 * same-file reference) so `vi.mock("./_daemon-helpers.js")` in tests can
 * actually intercept the call — a same-module self-reference keeps its
 * original binding even when the module's own exports object is mocked by
 * another file, which would otherwise make this untestable without a real
 * daemon.
 */
import { httpGetJson, type DaemonEndpoint } from "./_daemon-helpers.js"
import { formatDuration } from "../util/duration.js"

/**
 * Blocks until the policy resolves (leaves watching/gating/queued/nudging/
 * acting) or the total timeout budget is exhausted, chaining calls across
 * the route's own ~55s per-call ceiling.
 *
 * Both callers hit the exact same daemon endpoint, so a script that
 * branches on the exit code must see identical semantics regardless of
 * which verb it used to get there. `verb` is only the message prefix.
 *
 * Exit codes: 0 done or awaiting-ack (resolved — a human/ack step is next,
 * which is still "the gate settled", not "still running"); 2 blocked,
 * cancelled, or the CLI's own total-timeout budget ran out; 3 not found or
 * the daemon predates this route (HTTP 404 / 501).
 */
export async function waitForPolicy(opts: {
  endpoint: DaemonEndpoint
  policyId: string
  totalTimeoutMs: number
  json: boolean
  verb: string
}): Promise<number> {
  const { endpoint, policyId, totalTimeoutMs, json, verb } = opts
  const deadline = Date.now() + totalTimeoutMs
  // Per-call server cap is 55s; pick a slice that leaves headroom.
  const sliceMs = 50_000

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      if (json) {
        process.stdout.write(
          JSON.stringify({ timedOut: true, policyId, totalTimeoutMs }, null, 2) + "\n",
        )
      } else {
        process.stdout.write(
          `${verb}: policy "${policyId}" timed out after ${formatDuration(totalTimeoutMs)}. ` +
            `Pass a longer --timeout (e.g. --timeout 30m) if the gate is still running.\n`,
        )
      }
      return 2
    }
    const callTimeout = Math.min(sliceMs, remaining)
    const qs = new URLSearchParams({ timeoutMs: String(callTimeout) })
    const url = `${endpoint.url}/policies/${encodeURIComponent(policyId)}/wait?${qs.toString()}`
    let result: Record<string, unknown>
    try {
      result = await httpGetJson<Record<string, unknown>>(url)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/HTTP 404/.test(msg)) {
        process.stderr.write(`${verb}: no policy "${policyId}".\n`)
        return 3
      }
      if (/HTTP 501/.test(msg)) {
        process.stderr.write(`${verb}: daemon does not expose the policy wait endpoint (${msg}).\n`)
        return 3
      }
      process.stderr.write(`${verb}: ${msg}\n`)
      return 3
    }
    if (result.timedOut === true) continue
    const status = typeof result.status === "string" ? result.status : ""
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      process.stdout.write(`${verb}: policy ${policyId} → ${status}\n`)
    }
    if (status === "done") return 0
    if (status === "blocked" || status === "cancelled") return 2
    // awaiting-ack: resolved (out of watching/gating) but needs a human —
    // treat as a match (condition met) and exit 0.
    return 0
  }
}
