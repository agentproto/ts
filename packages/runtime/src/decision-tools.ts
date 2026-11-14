/**
 * `decision_decide` — the callable MCP seam for the decision router
 * (`decision.ts` + `decision-policy.ts`), registered on the root `/mcp`
 * server next to `model_roles`. Workflows (review routing, steward classify,
 * …) call it from `tool` steps the same way they call `session_judge_jev`:
 * pass a DECISION.md (as markdown text) plus the domain evidence object;
 * get back a validated closed choice with provenance.
 *
 * The classifier backend is the existing generic Jev client
 * (`callJevSystemOne`), resolved through `resolveJevApiKey`/`resolveJevConfig`
 * — no new credential surface. No escalation backend is wired here: the
 * harness escalation lives in the staged workflow tools
 * (`decision-workflow-tools.ts`), where the execution profile gates it before
 * any spawn. Acts on nothing; never an MCP error result for a failed
 * classification.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { decide, type ClassifierOutcome, type DecisionBackendIdentity } from "@agentproto/decision"
import { parseDecisionPolicy } from "@agentproto/decision"
import {
  callJevSystemOne,
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_URL,
  resolveJevApiKey,
  resolveJevConfig,
} from "./jev-client.js"

const JEV_QUESTION_KEY = "decision"

/** Jev adapter for `decide()`: one typed-choice call over the policy's
 *  closed choice set. Failures come back `{ ok:false }` — never thrown. */
export function makeJevDecisionClassifier(opts: {
  readonly apiKey: string | null
  readonly model?: string | undefined
  readonly baseUrl?: string | undefined
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  /** Transient-status retries inside the Jev client (default: the client's own). */
  readonly maxRetries?: number | undefined
  /** Per-attempt timeout (default: the client's own). */
  readonly timeoutMs?: number | undefined
}): (input: { state: unknown; question: { instructions: string; criteria: Readonly<Record<string, string>> } }) => Promise<ClassifierOutcome> {
  return async input => {
    if (!opts.apiKey) return { ok: false, error: "JEV_API_KEY not configured" }
    const outcome = await callJevSystemOne(
      input.state,
      {
        [JEV_QUESTION_KEY]: {
          type: "choice",
          instructions: input.question.instructions,
          criteria: input.question.criteria,
        },
      },
      {
        apiKey: opts.apiKey,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
    )
    if (!outcome.ok) return { ok: false, error: outcome.error }
    const answer = outcome.answers[JEV_QUESTION_KEY]
    if (!answer) {
      const why = outcome.answerErrors?.[JEV_QUESTION_KEY]
      return { ok: false, error: `response missing a valid answer${why ? ` — ${why}` : ""}` }
    }
    const probabilities: Record<string, number> = {}
    for (const [k, v] of Object.entries(answer.probabilities)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) probabilities[k] = v
    }
    const confidence = answer.confidence ?? probabilities[answer.choice]
    return {
      ok: true,
      choice: answer.choice,
      probabilities,
      ...(typeof confidence === "number" && Number.isFinite(confidence) ? { confidence } : {}),
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
    }
  }
}

/** Cache identity of the Jev backend: kind + endpoint host + model. A key
 *  change (different model/host) must never replay another backend's answer. */
export function jevClassifierIdentity(
  model: string | undefined,
  baseUrl: string | undefined,
): DecisionBackendIdentity {
  let host = "default"
  try {
    host = new URL(baseUrl ?? JEV_DEFAULT_URL).host
  } catch {
    host = "invalid-url"
  }
  return { kind: "jev", host, model: model ?? JEV_DEFAULT_MODEL }
}

export function registerDecisionTools(server: McpServer): void {
  server.tool(
    "decision_decide",
    "Resolve ONE closed-set decision from a DECISION.md policy plus domain " +
      "evidence: ordered rules first (mandatory floors cannot be downgraded), " +
      "then at most one bounded Jev typed-choice classifier call, then the " +
      "policy's conservative default. Returns `{ choice, source, matchedRules, " +
      "probabilities?, confidence?, margin?, policyHash, evidenceHash, " +
      "classifierConfigHash, escalationHistory, truncated, incompleteEvidence, " +
      "status }` — never an error result for a failed classification, never a " +
      "mutation. `source` is rule | rule-floor | classifier | escalation | default; " +
      "`status` is `decided` or `fallback` (the conservative default applied — a " +
      "safe answer, not a trusted one, and never cached). Only choices declared in " +
      "the policy can appear. The default export policy sends no " +
      "paths/code/messages to the classifier. No escalation runs here; use the " +
      "`decision_*` workflow stage tools for the profile-gated harness escalation.",
    {
      policy: z
        .string()
        .min(1)
        .describe("The DECISION.md contents (markdown with YAML frontmatter)."),
      evidence: z
        .record(z.string(), z.unknown())
        .describe(
          "Domain evidence object the rules/classifier evaluate (counts, " +
            "flags, risk signals). Paths/code/messages are stripped before " +
            "the classifier unless the policy's evidence policy allows them.",
        ),
    },
    async input => {
      const parsed = parseDecisionPolicy(input.policy)
      if (!parsed.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, errors: parsed.errors }) }],
        }
      }
      const jevCfg = await resolveJevConfig()
      const classifierModel = parsed.policy.classifier.model ?? jevCfg.model
      const outcome = await decide(parsed.policy, input.evidence, {
        classify: makeJevDecisionClassifier({
          apiKey: await resolveJevApiKey(),
          ...(classifierModel !== undefined ? { model: classifierModel } : {}),
          ...(jevCfg.baseUrl !== undefined ? { baseUrl: jevCfg.baseUrl } : {}),
        }),
        classifierIdentity: jevClassifierIdentity(classifierModel, jevCfg.baseUrl),
      })
      return { content: [{ type: "text", text: JSON.stringify(outcome) }] }
    },
  )
}
