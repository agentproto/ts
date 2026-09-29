/**
 * Minimal Jev (TypeSafe System One) client — a calibrated judge that answers
 * TYPED questions with probabilities. Ported (choice questions only) from
 * openagentik's `forge/packages/cli/src/ports/jev-judge.adapter.ts`
 * (`callJevSystemOne`); that repo is not a dependency, so this is a copy of
 * the contract, not an import: POST `https://api.typesafe.ai/v1/systemone`,
 * `Authorization: Bearer <key>`, body `{ model, state, questions }`, bounded
 * retries on 429/5xx (backoff, or the server's `Retry-After`), a per-attempt
 * timeout, per-answer schema parse, and it NEVER throws.
 *
 * `judgeSessionWithJev` is the session-steward's use of it (FIX-9B): one
 * `choice` question over the five wrap-up verdicts, state = the evidence
 * object from `session_evidence`.
 */

import { z } from "zod"
import { getMcpCredentialDeps } from "./mcp-credential-deps.js"
import { loadConfig } from "./config.js"
import type { JevConfig } from "./config.js"

export const JEV_DEFAULT_URL = "https://api.typesafe.ai/v1/systemone"
export const JEV_DEFAULT_MODEL = "jev-latest"
export const JEV_API_KEY_ENV = "JEV_API_KEY"

export interface JevChoiceQuestion {
  readonly type: "choice"
  readonly instructions: string
  /** Option key → what that option means. */
  readonly criteria: Readonly<Record<string, string>>
}

const jevChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1),
  // Optional — callers fall back to `probabilities[choice]` (a strict number
  // here would turn any response omitting it into a total parse failure).
  confidence: z.number().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number()).default({}),
})
export type JevChoiceAnswer = z.infer<typeof jevChoiceAnswerSchema>

/** Envelope parsed loosely; each answer is parsed on its own so one bad
 *  entry doesn't sink the others. */
const jevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
})

export type JevCallOutcome =
  | {
      readonly ok: true
      readonly model?: string
      readonly answers: Readonly<Record<string, JevChoiceAnswer>>
      /** Why an answer the response DID carry was dropped, by question key. */
      readonly answerErrors?: Readonly<Record<string, string>>
    }
  | { readonly ok: false; readonly error: string }

export interface JevClientOptions {
  readonly apiKey: string
  readonly fetchImpl?: typeof fetch
  /** Default {@link JEV_DEFAULT_MODEL}. */
  readonly model?: string
  /** Default {@link JEV_DEFAULT_URL}. */
  readonly baseUrl?: string
  /** Retries on a transient status (429/500/502/503/504/529). Default 3. */
  readonly maxRetries?: number
  readonly sleep?: (ms: number) => Promise<void>
  /** Per-attempt timeout. Default 30s. */
  readonly timeoutMs?: number
}

/** 401/422 and other 4xx are caller errors — retrying them never helps. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])

function retryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

/** Exponential backoff off 500ms with jitter, unless the server names a
 *  `Retry-After`, which always wins. */
function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const fromHeader = retryAfterMs(retryAfterHeader)
  if (fromHeader !== null) return fromHeader
  const base = 500 * 2 ** (attempt - 1)
  return base * (0.5 + Math.random() * 0.5)
}

function describeZodIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join(", ")
}

/** POST one `state` + typed `questions` to Jev. Never throws — a network
 *  error/timeout, a non-2xx after retries, or an unparseable body all come
 *  back as `{ ok: false, error }`. */
export async function callJevSystemOne(
  state: unknown,
  questions: Readonly<Record<string, JevChoiceQuestion>>,
  opts: JevClientOptions,
): Promise<JevCallOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = (opts.baseUrl ?? JEV_DEFAULT_URL).replace(/\/+$/, "")
  const maxRetries = opts.maxRetries ?? 3
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const model = opts.model ?? JEV_DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? 30_000

  let attempt = 0
  for (;;) {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      return { ok: false, error: `request failed — ${e instanceof Error ? e.message : String(e)}` }
    }

    if (res.ok) {
      let raw: unknown
      try {
        raw = await res.json()
      } catch (e) {
        return { ok: false, error: `${res.status} response body was not JSON — ${e instanceof Error ? e.message : String(e)}` }
      }
      const parsed = jevResponseSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, error: "response did not parse into a valid Jev answer set" }
      const answers: Record<string, JevChoiceAnswer> = {}
      const answerErrors: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed.data.answers)) {
        const answer = jevChoiceAnswerSchema.safeParse(value)
        if (answer.success) answers[key] = answer.data
        else answerErrors[key] = describeZodIssues(answer.error)
      }
      return {
        ok: true,
        ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
        answers,
        ...(Object.keys(answerErrors).length > 0 ? { answerErrors } : {}),
      }
    }

    if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      attempt++
      await sleep(backoffDelayMs(attempt, res.headers.get("retry-after")))
      continue
    }
    const body = await res.text().catch(() => "")
    return { ok: false, error: `${res.status} ${body.slice(0, 300)}` }
  }
}

/** Config-file loader seam — production reads `~/.agentproto/config.json`
 *  via {@link loadConfig}; tests inject a stub so resolution never touches
 *  (or leaks) a real user config. */
export type JevConfigLoader = () => Promise<{ jev?: JevConfig }>
let configLoader: JevConfigLoader = loadConfig
/** Test-only: swap the config source used by `resolveJevApiKey` /
 *  `resolveJevConfig`. Pass `loadConfig` to restore production behavior. */
export function setJevConfigLoader(loader: JevConfigLoader): void {
  configLoader = loader
}

/** Resolve the Jev API key: `jev.apiKey` from `~/.agentproto/config.json`
 *  first (Jev is a first-party dependency — the key belongs in agentproto's
 *  own config, not a workspace env file), then the `JEV_API_KEY`
 *  environment variable, then the host-injected secret resolver (the same
 *  broker sandbox env passthrough uses), else null. */
export async function resolveJevApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const cfg = (await configLoader()).jev?.apiKey
    if (cfg && cfg.trim()) return cfg.trim()
  } catch {
    // config unreadable — fall through to the env var
  }
  const fromEnv = env[JEV_API_KEY_ENV]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const resolver = getMcpCredentialDeps().resolveSandboxSecret
  if (!resolver) return null
  try {
    const v = await resolver(JEV_API_KEY_ENV)
    return v && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/** Jev model/baseUrl preferences from the config file (`jev.model`,
 *  `jev.baseUrl`), for callers that take an optional model override. */
export async function resolveJevConfig(): Promise<{ model?: string; baseUrl?: string }> {
  try {
    const jev = (await configLoader()).jev
    return {
      ...(jev?.model?.trim() ? { model: jev.model.trim() } : {}),
      ...(jev?.baseUrl?.trim() ? { baseUrl: jev.baseUrl.trim() } : {}),
    }
  } catch {
    return {}
  }
}

// ── session-steward judge ────────────────────────────────────────────────

export const WRAPUP_VERDICTS = ["done", "abandoned", "blocked", "needs-input", "active"] as const
export type WrapupVerdict = (typeof WRAPUP_VERDICTS)[number]

/** Same definitions as the agent judge's prompt (session-steward entry.mjs). */
export const WRAPUP_VERDICT_CRITERIA: Readonly<Record<WrapupVerdict, string>> = {
  done: "The task visibly finished: a PR was opened or merged, a final report was given, or the user said thanks/ok with nothing pending.",
  abandoned: "Superseded or a dead end, with nothing worth keeping.",
  blocked: "Waiting on something external (CI, another session, a dependency).",
  "needs-input": "Waiting on a human answer or decision.",
  active: "Mid-work — keep it. Also the answer when unsure.",
}

const VERDICT_QUESTION_KEY = "verdict"

export type JevWrapupJudgement =
  | {
      ok: true
      sessionId: string
      verdict: WrapupVerdict
      confidence: number
      probabilities: Record<string, number>
      model: string
    }
  | { ok: false; sessionId: string; error: string; noKey?: true; model: string }

/**
 * Judge ONE idle session with Jev. `apiKey: null` ⇒ `{ ok:false, noKey:true }`
 * without a network call. Every other failure — transport, non-2xx after
 * retries, a missing/malformed answer, a choice outside the five verdicts, no
 * usable confidence — is `{ ok:false, error }`; the caller falls back, it
 * never acts on it.
 */
export async function judgeSessionWithJev(input: {
  sessionId: string
  evidence: unknown
  apiKey: string | null
  model?: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  baseUrl?: string
}): Promise<JevWrapupJudgement> {
  const model = input.model ?? JEV_DEFAULT_MODEL
  const fail = (error: string, noKey?: true): JevWrapupJudgement => ({
    ok: false,
    sessionId: input.sessionId,
    error,
    ...(noKey ? { noKey } : {}),
    model,
  })
  if (!input.apiKey) return fail(`${JEV_API_KEY_ENV} not set`, true)
  const outcome = await callJevSystemOne(
    input.evidence,
    {
      [VERDICT_QUESTION_KEY]: {
        type: "choice",
        instructions:
          "The state is the evidence for ONE idle AI coding-agent session. Is its task finished? " +
          "Closing a session that still had work is worse than leaving an idle one open — when unsure, choose `active`.",
        criteria: WRAPUP_VERDICT_CRITERIA,
      },
    },
    {
      apiKey: input.apiKey,
      model,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    },
  )
  if (!outcome.ok) return fail(outcome.error)
  const answer = outcome.answers[VERDICT_QUESTION_KEY]
  if (!answer) {
    const why = outcome.answerErrors?.[VERDICT_QUESTION_KEY]
    return fail(`response missing a valid verdict answer${why ? ` — ${why}` : ""}`)
  }
  if (!(WRAPUP_VERDICTS as readonly string[]).includes(answer.choice)) {
    return fail(`unknown verdict choice '${answer.choice}'`)
  }
  const confidence = answer.confidence ?? answer.probabilities[answer.choice]
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return fail("no usable confidence for the chosen verdict")
  }
  return {
    ok: true,
    sessionId: input.sessionId,
    verdict: answer.choice as WrapupVerdict,
    confidence,
    probabilities: answer.probabilities,
    model: outcome.model ?? model,
  }
}
