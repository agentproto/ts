/**
 * Harness fit check — whether an agent harness's known first-request token
 * size fits inside an inference endpoint's LOADED context, checked BEFORE a
 * session is spawned against it. A harness with a big tool-preamble (e.g.
 * claude-code) can otherwise be spawned blind against a small local model and
 * die with an opaque upstream 400/500 minutes later.
 *
 * Dependency-free and side-effect-free at import time, like `connectors.ts`/
 * `endpoints.ts`/`packs.ts` — both `@agentproto/cli` and `@agentproto/runtime`
 * import this directly, so it stays a pure leaf module.
 */

export type FitVerdict = 'fits' | 'no-fit' | 'unknown';

export interface HarnessFirstRequestSize {
  /** Measured (or best-known) first-request token count for this harness. */
  tokens: number;
  /** Where the number came from — printed alongside it in `doctor`/PR bodies
   *  so a stale or unmeasured figure is never mistaken for a fresh one. */
  source: string;
}

/**
 * First-request token size per harness/adapter slug — the size of the FIRST
 * request a fresh session of that harness sends (tool defs + system preamble
 * + the first user turn), before any real conversation has accumulated.
 *
 * `claude-sdk`'s figure predates SPIKE-A (not re-measured there, carried over
 * from the design doc's "deferred mode" measurement). `pi`'s figure
 * SUPERSEDES an earlier ~2k design-doc estimate once SPIKE-A actually
 * measured it against a real endpoint. Harnesses absent from this table
 * (e.g. `opencode`) have never been measured — callers must treat that as
 * `unknown` (see {@link checkHarnessFit}), never guess a number.
 */
export const HARNESS_FIRST_REQUEST_SIZE: Readonly<Record<string, HarnessFirstRequestSize>> = {
  'claude-code': {
    tokens: 35_925,
    source: 'SPIKE-A-RESULTS.md — two real runs against a local endpoint, 35,925/35,924 tokens (2026-09-27)',
  },
  'claude-sdk': {
    tokens: 18_200,
    source:
      'INFERENCE-ENDPOINTS-DESIGN.md — "deferred mode" measurement (2026-09-27); not re-measured in SPIKE-A, may be stale',
  },
  pi: {
    tokens: 7_504,
    source:
      'SPIKE-A-RESULTS.md — real cross-device runs, 7,466-7,504 tokens (2026-09-27); supersedes an earlier ~2k design-doc estimate',
  },
};

/** Default headroom: the endpoint's loaded ctx must be at least
 *  `requiredTokens / (1 - DEFAULT_HEADROOM_RATIO)` — i.e. the first request
 *  may use at most `1 - DEFAULT_HEADROOM_RATIO` of the loaded ctx. Matches
 *  the plan's own worked example (36k required, 25% headroom ⇒ "ctx >= 48k",
 *  since 36000 / 0.75 = 48000). */
export const DEFAULT_HEADROOM_RATIO = 0.25;

export interface FitCheckInput {
  /** Adapter/harness slug, e.g. "claude-code", "pi". */
  harness: string;
  /** The endpoint's loaded ctx (from a connector's `listModels().loadedCtx`),
   *  or `undefined` when the runtime doesn't expose one (e.g. Ollama). */
  loadedCtx: number | undefined;
  /** Fraction of the loaded ctx to hold back as headroom. Default 25%. */
  headroomRatio?: number;
  /** Human label for the endpoint, used in the actionable message — e.g.
   *  `"lmstudio@win-pc"`. Defaults to a generic phrase when omitted. */
  endpointLabel?: string;
}

export interface FitCheckResult {
  verdict: FitVerdict;
  /** The harness's known first-request size, when known. */
  requiredTokens?: number;
  /** The endpoint's loaded ctx, echoed back, when known. */
  loadedCtx?: number;
  /** The effective minimum loaded ctx this harness needs at the applied
   *  headroom — `requiredTokens / (1 - headroomRatio)`, rounded up. */
  thresholdTokens?: number;
  headroomRatio: number;
  /** Actionable, human-readable explanation — present on `no-fit` and
   *  `unknown` (absent on `fits`, nothing to explain). */
  message?: string;
}

/**
 * Compare a harness's known first-request size against an endpoint's loaded
 * ctx. Never throws. Returns `unknown` (never blocks a caller on its own —
 * see the plan's "`unknown` must not block but must warn" rule) when either
 * the harness's size or the endpoint's loaded ctx isn't known; `no-fit` with
 * an actionable message when the harness's first request would not fit
 * inside the loaded ctx at the requested headroom; `fits` otherwise.
 */
export function checkHarnessFit(input: FitCheckInput): FitCheckResult {
  const headroomRatio = input.headroomRatio ?? DEFAULT_HEADROOM_RATIO;
  const label = input.endpointLabel ?? 'this endpoint';
  const size = HARNESS_FIRST_REQUEST_SIZE[input.harness];

  if (!size) {
    return {
      verdict: 'unknown',
      headroomRatio,
      message:
        `"${input.harness}"'s first-request size has not been measured — proceeding without a fit check. ` +
        `If the spawn fails with a context-overflow error against ${label}, that is why.`,
    };
  }

  const requiredTokens = size.tokens;
  const thresholdTokens = Math.ceil(requiredTokens / (1 - headroomRatio));

  if (input.loadedCtx === undefined) {
    return {
      verdict: 'unknown',
      requiredTokens,
      thresholdTokens,
      headroomRatio,
      message:
        `${label}'s loaded context size is unknown (this runtime doesn't report it) — proceeding without a ` +
        `fit check. "${input.harness}" needs ~${formatK(requiredTokens)} tokens for its first request.`,
    };
  }

  if (input.loadedCtx >= thresholdTokens) {
    return { verdict: 'fits', requiredTokens, loadedCtx: input.loadedCtx, thresholdTokens, headroomRatio };
  }

  return {
    verdict: 'no-fit',
    requiredTokens,
    loadedCtx: input.loadedCtx,
    thresholdTokens,
    headroomRatio,
    message:
      `"${input.harness}" needs ~${formatK(requiredTokens)} tokens for its first request, ${label} has ` +
      `${formatK(input.loadedCtx)} loaded: use a harness with a smaller first request (e.g. pi), or reload ` +
      `the model with ctx >= ${formatK(thresholdTokens)}.`,
  };
}

function formatK(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}
