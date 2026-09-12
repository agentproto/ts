/**
 * Runtime credential probe for the moonshot live-e2e suite: can THIS key
 * actually transact against Moonshot's Anthropic-compatible endpoint?
 * A `MOONSHOT_API_KEY` that is present but dead (no credit / suspended) is
 * strictly worse than no key at all — the old presence-only gate opened the
 * suite, which then burned its full 45s idle timeout and failed, on every
 * local run, forever. We make the smallest request that authenticates (a
 * 1-token completion — never more than a token or two) once per process,
 * classify the observed response, and cache the verdict. No environment
 * sniffing (no CI/hostname/user checks).
 *
 * The probe runs in a child node process (execFileSync) because the test
 * file needs the verdict synchronously at describe-registration time — the
 * same shape `loopbackBindCapability.ts` uses. The classification rule, and
 * it is the crux:
 *
 *   - key works                → run the suite (no behaviour change)
 *   - key DEFINITIVELY dead    → SKIP loudly (401 / 402 / 403, or a 429 whose
 *                                body says quota/credit exhaustion — the
 *                                observed dead-key response is 429 with
 *                                type "exceeded_current_quota_error" and
 *                                "insufficient balance" in the message)
 *   - anything else            → RUN and fail honestly. A network error, a
 *                                5xx, a timeout, an unparseable body, a
 *                                transient 429 — none of these are "the
 *                                credential is dead", and swallowing them
 *                                would hide exactly the regressions this
 *                                suite exists to catch. If in doubt: run.
 *
 * `TEST_OVERRIDE` is a test-only hook that forces the probe result so the
 * skip path can be exercised on a working credential; nothing in production
 * code reads it.
 */
import { execFileSync } from "node:child_process"

export type CredentialProbe = { supported: boolean; reason: string }

export const TEST_OVERRIDE: { value: CredentialProbe | null } = { value: null }

let cached: CredentialProbe | null = null

/** Status the child reports when the key env var is absent. */
const NO_CREDENTIAL = -1

const CHILD_SCRIPT = `
const key = process.env.MOONSHOT_API_KEY
if (!key) {
  console.log(JSON.stringify({ status: ${NO_CREDENTIAL}, body: "" }))
} else {
  const url = (process.env.MOONSHOT_BASE_URL || "https://api.moonshot.ai/anthropic") + "/v1/messages"
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.MOONSHOT_PROBE_MODEL || "kimi-k2.7-code",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(5000),
  }).then(async (res) => {
    const body = await res.text().catch(() => "")
    console.log(JSON.stringify({ status: res.status, body: body.slice(0, 500) }))
  }).catch((err) => {
    console.log(JSON.stringify({ status: 0, body: String((err && err.message) || err) }))
  })
}
`

/**
 * Pure classifier for one observed probe response. `status: 0` is a network /
 * timeout failure, `status: ${NO_CREDENTIAL}` is "no key set". Anything that
 * is not a definitive "your key is bad or broke" verdict falls through to
 * "run the suite" — an ambiguous failure must surface as a real test failure,
 * never as a skip.
 */
export function classifyMoonshotResponse(
  status: number,
  body: string,
): CredentialProbe {
  if (status === NO_CREDENTIAL) {
    return { supported: false, reason: "MOONSHOT_API_KEY not set" }
  }
  if (status >= 200 && status < 300) {
    return { supported: true, reason: "" }
  }
  const snippet = body ? ` — ${body.slice(0, 120)}` : ""
  if (status === 401 || status === 402 || status === 403) {
    return {
      supported: false,
      reason: `Moonshot rejected the credential (HTTP ${status})${snippet}`,
    }
  }
  // A 429 is only a dead key when the body says quota/credit exhaustion
  // (observed live: type "exceeded_current_quota_error", "insufficient
  // balance"). A transient rate-limit 429 is ambiguous → run.
  if (
    status === 429 &&
    /quota|credit|balance|insufficient|exhaust|arrears|recharge/i.test(body)
  ) {
    return {
      supported: false,
      reason: `Moonshot credential cannot transact (HTTP 429 quota/credit exhaustion)${snippet}`,
    }
  }
  return { supported: true, reason: "" }
}

export function probeMoonshotCredential(): CredentialProbe {
  if (TEST_OVERRIDE.value) return TEST_OVERRIDE.value
  if (cached) return cached
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
    cached = classifyMoonshotResponse(parsed.status ?? 0, parsed.body ?? "")
  } catch {
    // The probe itself failed (child crashed, timed out, unparseable output).
    // That is ambiguous, not a dead key — run the suite and fail honestly.
    cached = { supported: true, reason: "" }
  }
  return cached
}
