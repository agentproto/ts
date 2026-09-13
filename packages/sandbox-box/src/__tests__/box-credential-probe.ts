/**
 * Runtime credential probe for the Box integration suite: can BOX_API_KEY
 * actually authenticate against the Box control plane? A key that is present
 * but dead (invalid / expired) is strictly worse than no key — the old
 * presence-only gate opened the suite, which then failed on every local run.
 * We make the smallest request that authenticates once per process (a GET on
 * the sandbox list — an auth check ONLY; Box bills for boxes, so this probe
 * never provisions or boots anything), classify the observed response, and
 * cache the verdict. No environment sniffing.
 *
 * Classification rule (the crux — see the moonshot probe for the shared
 * rationale): 2xx → run; a definitive "your key is bad or broke" (401/402/
 * 403, or a 429 whose body says quota/credit exhaustion) → SKIP loudly;
 * anything else (network error, 5xx, timeout, unparseable body, transient
 * 429) → RUN and fail honestly. If in doubt: run.
 *
 * `TEST_OVERRIDE` is a test-only hook that forces the probe result so the
 * skip path can be exercised on a working credential; nothing in production
 * code reads it.
 */
import { execFileSync } from "node:child_process"

export type CredentialProbe = { supported: boolean; reason: string }

export const TEST_OVERRIDE: { value: CredentialProbe | null } = { value: null }

let cached: CredentialProbe | null = null

const CHILD_SCRIPT = `
const key = process.env.BOX_API_KEY
if (!key) {
  console.log(JSON.stringify({ status: 401, body: "" }))
} else {
  fetch((process.env.BOX_API_BASE_URL || "https://ascii.dev/api/box/v1") + "/sandboxes", {
    headers: { Authorization: "Bearer " + key },
    signal: AbortSignal.timeout(5000),
  }).then(async (res) => {
    const body = await res.text().catch(() => "")
    console.log(JSON.stringify({ status: res.status, body: body.slice(0, 500) }))
  }).catch((err) => {
    console.log(JSON.stringify({ status: 0, body: String((err && err.message) || err) }))
  })
}
`

/** Pure classifier — same three-branch rule as the other credential probes. */
export function classifyBoxResponse(status: number, body: string): CredentialProbe {
  if (status === 0) {
    return { supported: true, reason: "" }
  }
  const snippet = body ? ` — ${body.slice(0, 120)}` : ""
  if (status === 401 || status === 402 || status === 403) {
    return {
      supported: false,
      reason: `BOX_API_KEY rejected the credential (HTTP ${status})${snippet}`,
    }
  }
  if (
    status === 429 &&
    /quota|credit|balance|insufficient|exhaust|arrears|recharge/i.test(body)
  ) {
    return {
      supported: false,
      reason: `BOX_API_KEY cannot transact (HTTP 429 quota/credit exhaustion)${snippet}`,
    }
  }
  return { supported: true, reason: "" }
}

export function probeBoxCredential(): CredentialProbe {
  if (TEST_OVERRIDE.value) return TEST_OVERRIDE.value
  if (cached) return cached
  if (!process.env.BOX_API_KEY) {
    cached = { supported: false, reason: "BOX_API_KEY not set" }
    return cached
  }
  try {
    const out = execFileSync(process.execPath, ["-e", CHILD_SCRIPT], {
      stdio: "pipe",
      timeout: 10_000,
      env: process.env,
    })
    const parsed = JSON.parse(out.toString()) as {
      status?: number
      body?: string
    }
    cached = classifyBoxResponse(parsed.status ?? 0, parsed.body ?? "")
  } catch {
    // Probe itself failed — ambiguous, not a dead key. Run and fail honestly.
    cached = { supported: true, reason: "" }
  }
  return cached
}
