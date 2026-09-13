/**
 * Runtime credential probes for the e2b integration suite, which needs TWO
 * credentials that actually transact: `E2B_API_KEY` (the sandbox control
 * plane) and `OPENROUTER_API_KEY` (the in-sandbox agent turn). A key that is
 * present but dead (invalid / no credit) is strictly worse than no key — the
 * old presence-only gate opened the suite, which then failed on every local
 * run. Each probe makes the smallest request that authenticates once per
 * process, classifies the observed response, and caches the verdict. No
 * environment sniffing.
 *
 * Both probes are auth checks ONLY — free metadata/list endpoints, never a
 * sandbox boot or any billable resource (E2B and OpenRouter bill for usage;
 * these GETs cost nothing).
 *
 * Classification rule (the crux — see the moonshot probe for the shared
 * rationale): 2xx → run; a definitive "your key is bad or broke" (401/402/
 * 403, or a 429 whose body says quota/credit exhaustion) → SKIP loudly;
 * anything else (network error, 5xx, timeout, unparseable body, transient
 * 429) → RUN and fail honestly. If in doubt: run.
 *
 * `TEST_OVERRIDE` is a test-only hook that forces the probe result so the
 * skip path can be exercised on working credentials; nothing in production
 * code reads it.
 */
import { execFileSync } from "node:child_process"

export type CredentialProbe = { supported: boolean; reason: string }

export const TEST_OVERRIDE: { value: CredentialProbe | null } = { value: null }

const caches = new Map<string, CredentialProbe>()

const CHILD_SCRIPT = `
const key = process.env[process.env.PROBE_ENV_NAME ?? ""]
if (!key) {
  console.log(JSON.stringify({ status: 401, body: "" }))
} else {
  fetch(process.env.PROBE_URL ?? "", {
    headers: { [process.env.PROBE_HEADER_NAME ?? ""]: key },
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
 * timeout failure. An absent key reports as unsupported (the suite's
 * presence gate would skip anyway); every ambiguous outcome falls through
 * to "run the suite".
 */
export function classifyCredentialResponse(
  credential: string,
  status: number,
  body: string,
): CredentialProbe {
  if (status === 0) {
    return { supported: true, reason: "" }
  }
  const snippet = body ? ` — ${body.slice(0, 120)}` : ""
  if (status === 401 || status === 402 || status === 403) {
    return {
      supported: false,
      reason: `${credential} rejected the credential (HTTP ${status})${snippet}`,
    }
  }
  if (
    status === 429 &&
    /quota|credit|balance|insufficient|exhaust|arrears|recharge/i.test(body)
  ) {
    return {
      supported: false,
      reason: `${credential} cannot transact (HTTP 429 quota/credit exhaustion)${snippet}`,
    }
  }
  return { supported: true, reason: "" }
}

/**
 * One auth check against `url` with the credential in header `headerName`
 * (read from env `envName`). Cached per process per `cacheKey`, whether it
 * succeeds or fails. The probe itself failing (child crash, timeout,
 * unparseable output) is ambiguous → run.
 */
function probeHttpCredential(
  cacheKey: string,
  credential: string,
  url: string,
  headerName: string,
  envName: string,
): CredentialProbe {
  const hit = caches.get(cacheKey)
  if (hit) return hit
  if (TEST_OVERRIDE.value) return TEST_OVERRIDE.value
  let verdict: CredentialProbe
  try {
    const out = execFileSync(process.execPath, ["-e", CHILD_SCRIPT], {
      stdio: "pipe",
      timeout: 10_000,
      env: { ...process.env, PROBE_URL: url, PROBE_HEADER_NAME: headerName, PROBE_ENV_NAME: envName },
    })
    const parsed = JSON.parse(out.toString()) as {
      status?: number
      body?: string
    }
    verdict = classifyCredentialResponse(
      credential,
      parsed.status ?? 0,
      parsed.body ?? "",
    )
  } catch {
    verdict = { supported: true, reason: "" }
  }
  caches.set(cacheKey, verdict)
  return verdict
}

/** Free list endpoint on E2B's control plane — authenticates, provisions nothing. */
export function probeE2bCredential(): CredentialProbe {
  if (!process.env.E2B_API_KEY) {
    return { supported: false, reason: "E2B_API_KEY not set" }
  }
  return probeHttpCredential(
    "e2b",
    "E2B_API_KEY",
    "https://api.e2b.dev/sandboxes",
    "X-E2B-API-Key",
    "E2B_API_KEY",
  )
}

/** Free key-metadata endpoint on OpenRouter — authenticates, costs nothing. */
export function probeOpenRouterCredential(): CredentialProbe {
  if (!process.env.OPENROUTER_API_KEY) {
    return { supported: false, reason: "OPENROUTER_API_KEY not set" }
  }
  return probeHttpCredential(
    "openrouter",
    "OPENROUTER_API_KEY",
    "https://openrouter.ai/api/v1/auth/key",
    "Authorization",
    "OPENROUTER_API_KEY",
  )
}
