// Credential rotation for the agentproto-run action: the pure half.
//
// A lane that funds its model with an API key used to take the FIRST key that
// was set (`secrets.A || secrets.B || secrets.C`), not the first one that still
// works. When that key's quota or credit ran out ("Free usage limit reached",
// "insufficient balance"), the review failed even though the next key was
// fine. The `credential-ladder` input lists the keys in order; run-with-
// rotation.mjs runs the driver with the first usable rung and, when a run
// fails because the key's quota or credit is exhausted, the key expired, or
// the turn came back empty (see `rotationDecision`), runs it again with the
// next rung. Nothing here reads or prints a key value except to pass it on.
//
// Ladder grammar, one rung per line (blank lines and `#` comments ignored):
//
//   <KEY_ENV> <ROUTE | MODEL> [<EXPORT_ENV> ...]
//
//   · KEY_ENV: the env var on the action step that holds the key (from a
//     secret). Every KEY_ENV is removed from the driver's env; only the active
//     rung's key reaches the daemon, under the action's `provider-key-env` and
//     in the adapter auth of `~/.agentproto/config.json`.
//   · ROUTE (`opencode`) or MODEL (`opencode-go/deepseek-v4.1-flash`): the
//     model route this key funds (the provider prefix before the `/`). When the
//     lane model is on that route the rung runs the lane model; otherwise it
//     runs MODEL, and a rung given only a ROUTE is skipped (that key cannot
//     fund the lane model).
//   · EXPORT_ENV: extra env names that also receive the rung's key (an adapter
//     that reads a second variable for the same route).

/** Failure reasons that move a lane to its next credential. A refused key
 *  (`Invalid credential`, 401) is the one failure that does not. */
export const ROTATE_CLASSES = ["usage-limit", "credit-exhausted", "key-expired", "empty-turn"]

// A quota cap on the key ("Free usage limit reached", "Go usage limit
// exceeded", Claude's "hit your weekly limit", OpenAI's "exceeded your current
// quota"). A plain rate limit (429, "too many requests") is NOT one: it clears
// with backoff on the same key, which the session's own turnRetry handles.
const USAGE_LIMIT_RE =
  /\busage limit (?:reached|exceeded)\b|\bhit your (?:session|usage|weekly(?: usage)?) limit\b|\b(?:weekly|monthly|daily) limit (?:reached|exceeded)\b|\bquota (?:reached|exceeded|exhausted)\b|\bexceeded your (?:current )?quota\b|\binsufficient_quota\b|\bspend(?:ing)? limit (?:reached|exceeded)\b/i

// The key's prepaid balance is gone. "Invalid credential" / 401 is NOT one:
// a refused key is a configuration error, not something the next key fixes
// silently.
const CREDIT_EXHAUSTED_RE =
  /\binsufficient[ _-]?(?:credits?|balance|funds)\b|\bcredit balance (?:is )?too low\b|\bout of credits?\b|\bcredits? (?:exhausted|depleted)\b|\bbalance (?:is )?(?:exhausted|depleted|insufficient)\b|\bpayment required\b|\b(?:HTTP|status|code)[ :=]*402\b/i

// The key is dead for good ("This API key has expired. Create a new API key in
// OpenCode Console"): the next key may still work.
const KEY_EXPIRED_RE = /\b(?:api )?key (?:has )?expired\b|\bexpired (?:api )?key\b/i

// The provider refused the key itself. A wrong secret is a configuration error
// the owner must see, so the lane stops on it instead of hiding it.
const KEY_REFUSED_RE =
  /\binvalid[ _-]?(?:credentials?|api[ _-]?key|x-api-key|token)\b|\bunauthori[sz]ed\b|\b(?:HTTP|status|code)[ :=]*401\b|^\s*401\b/i

// The workflow host's wording for a turn with no assistant output and no tool
// call (sessions-registry-agent-host.ts). A capped or dead key often ends that
// way with no provider error line at all.
const EMPTY_TURN_RE = /\bproduced an empty turn\b/i

/**
 * Should a failed run move to the next rung? Checked in this order:
 *   1. a usage cap or exhausted credit (`classifyCredentialFailure`) rotates;
 *   2. an expired key rotates (`key-expired`);
 *   3. a refused key (`Invalid credential`, 401) does NOT rotate;
 *   4. an empty turn rotates (`empty-turn`): the run error says so, or the
 *      driver saw a session whose last turn was empty;
 *   5. anything else does not rotate.
 * The caller still only rotates a run that completed no step and delivered
 * nothing. Returns `{ rotate, reason }`.
 */
export function rotationDecision({ errorTexts, emptyTurn } = {}) {
  const texts = (errorTexts ?? []).filter(t => typeof t === "string" && t)
  const quota = classifyCredentialFailure(texts)
  if (quota) return { rotate: true, reason: quota }
  if (texts.some(t => KEY_EXPIRED_RE.test(t))) return { rotate: true, reason: "key-expired" }
  if (texts.some(t => KEY_REFUSED_RE.test(t))) return { rotate: false, reason: "key-refused" }
  if (emptyTurn === true || texts.some(t => EMPTY_TURN_RE.test(t))) return { rotate: true, reason: "empty-turn" }
  return { rotate: false, reason: "other" }
}

/** Classify one failed run from its error texts. Returns the first quota or
 *  credit class found, or undefined (the failure is not about the key's quota). */
export function classifyCredentialFailure(texts) {
  let credit = false
  for (const text of texts ?? []) {
    if (typeof text !== "string" || !text) continue
    if (USAGE_LIMIT_RE.test(text)) return "usage-limit"
    if (CREDIT_EXHAUSTED_RE.test(text)) credit = true
  }
  return credit ? "credit-exhausted" : undefined
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

// A role heading of an `agent_export` markdown transcript ("### 🧑 User",
// "### ⚙️ System", "### 🔧 Tool · `bash`", see transcript-export.ts ROLE_ICON).
// Other `### ` lines (a prompt's own markdown) do not change the section.
const ROLE_HEADING_RE = /^### \S+ (User|Assistant|Tool|System)\b/u

/** The adapter-reported error lines of a session's output or exported
 *  transcript: lines that start with `[error] ` once ANSI colour is stripped.
 *  Lines of a `### 🧑 User` message (the prompt, which can quote a prior
 *  review) are skipped, so prompt text cannot pose as a provider error. */
export function errorLinesFromText(text) {
  const out = []
  let inUserSection = false
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(ANSI_RE, "").trim()
    const role = ROLE_HEADING_RE.exec(line)
    if (role) {
      inUserSection = role[1] === "User"
      continue
    }
    if (inUserSection) continue
    if (line.startsWith("[error] ")) out.push(line.slice("[error] ".length))
  }
  return out
}

const routeOf = model => (typeof model === "string" && model.includes("/") ? model.slice(0, model.indexOf("/")) : "")

/** Same zero-priced test as the ci.yml metered guard. */
const isFreeModel = model => /-free$/.test(model) || /\/big-pickle$/.test(model)

/** Parse the ladder text into `{ keyEnv, route, model?, exportAs }` entries. */
export function parseCredentialLadder(spec) {
  const entries = []
  for (const raw of String(spec ?? "").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim()
    if (!line) continue
    const [keyEnv, target, ...exportAs] = line.split(/\s+/)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv ?? "")) {
      throw new Error(`credential-ladder: "${keyEnv}" is not an env var name`)
    }
    if (!target) throw new Error(`credential-ladder: ${keyEnv} names no route or model`)
    for (const name of exportAs) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`credential-ladder: ${keyEnv} exports to "${name}", which is not an env var name`)
      }
    }
    const isModel = target.includes("/")
    entries.push({
      keyEnv,
      route: isModel ? routeOf(target) : target,
      ...(isModel ? { model: target } : {}),
      exportAs,
    })
  }
  return entries
}

/**
 * Resolve the ladder into the rungs this run can try, in order.
 *
 *   · a rung whose KEY_ENV is unset or empty is skipped;
 *   · a rung holding the same key as an earlier one is skipped (one secret
 *     copied under two names would only be rotated onto itself);
 *   · the rung model is the lane model when it is on the rung's route, else
 *     the rung's own MODEL, else the rung is skipped;
 *   · a rung model other than the lane model must be zero-priced or listed in
 *     `allowedMetered` (the owner-only AGENT_ALLOWED_METERED_MODELS), the same
 *     fail-closed rule as the metered guard: the lane model already passed it;
 *   · a (key, model) pair listed in `exhausted` (an earlier lane of this job
 *     hit its cap) is skipped.
 *
 * Returns `{ rungs, skipped }`; `skipped` holds one log line per dropped rung
 * (env names and models only, never a value).
 */
export function resolveCredentialRungs({ ladder, env, laneModel, allowedMetered = [], exhausted = [] }) {
  const rungs = []
  const skipped = []
  const seen = new Map()
  const lane = typeof laneModel === "string" ? laneModel.trim() : ""
  for (const entry of ladder) {
    const value = env[entry.keyEnv]
    if (typeof value !== "string" || value.trim() === "") {
      skipped.push(`${entry.keyEnv} is not set`)
      continue
    }
    if (seen.has(value)) {
      skipped.push(`${entry.keyEnv} holds the same key as ${seen.get(value)}`)
      continue
    }
    seen.set(value, entry.keyEnv)
    let model
    if (lane && routeOf(lane) === entry.route) model = lane
    else if (entry.model) model = entry.model
    else {
      skipped.push(`${entry.keyEnv} funds the ${entry.route} route, the lane model ${lane || "(none)"} is not on it`)
      continue
    }
    if (model !== lane && !isFreeModel(model) && !allowedMetered.includes(model)) {
      skipped.push(`${entry.keyEnv}: ${model} is metered and not listed in AGENT_ALLOWED_METERED_MODELS`)
      continue
    }
    if (exhausted.includes(`${entry.keyEnv} ${model}`) || exhausted.includes(`${entry.keyEnv} *`)) {
      skipped.push(`${entry.keyEnv} already reported an exhausted quota or credit for ${model} in this job`)
      continue
    }
    rungs.push({ keyEnv: entry.keyEnv, model, exportAs: entry.exportAs })
  }
  return { rungs, skipped }
}

/** The exhausted-pair record of a failed rung: credit is per key, a usage
 *  cap is recorded for the (key, model) pair. */
export const exhaustedRecord = (rung, failureClass) =>
  failureClass === "credit-exhausted" ? `${rung.keyEnv} *` : `${rung.keyEnv} ${rung.model}`

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * The agentic-review config a rung runs with. The lane's model is what the
 * workflow's `model` selector reads (`reviewerModel`), so a rung model must
 * land there, not only in the adapter options: otherwise the session runs the
 * config's model with the rung's key (a Go key on a Zen model answers an
 * empty turn). Per-verb `commands.<verb>.reviewerModel` overrides and
 * `reviewerTurnRetry.rotate` targets on another route are moved to / dropped
 * for the rung model, since the rung's key cannot fund them.
 */
export function reviewConfigForRung(reviewConfig, model) {
  if (!isPlainObject(reviewConfig) || typeof model !== "string" || !model) return reviewConfig
  const route = routeOf(model)
  const next = { ...reviewConfig, reviewerModel: model, ...(reviewConfig.model !== undefined ? { model } : {}) }
  if (isPlainObject(reviewConfig.commands)) {
    const commands = {}
    for (const [verb, cfg] of Object.entries(reviewConfig.commands)) {
      commands[verb] =
        isPlainObject(cfg) && typeof cfg.reviewerModel === "string" && routeOf(cfg.reviewerModel) !== route
          ? { ...cfg, reviewerModel: model }
          : cfg
    }
    next.commands = commands
  }
  const retry = reviewConfig.reviewerTurnRetry
  if (isPlainObject(retry) && Array.isArray(retry.rotate)) {
    const rotate = retry.rotate.filter(t => !isPlainObject(t) || routeOf(t.model) === route)
    const { rotate: _dropped, ...rest } = retry
    next.reviewerTurnRetry = rotate.length > 0 ? { ...rest, rotate } : rest
  }
  return next
}

/** WORKFLOW_INPUT (a JSON string) with its `reviewConfig` moved to the rung
 *  model. A non-JSON input or one without a reviewConfig is returned as is. */
export function workflowInputForRung(workflowInput, model) {
  let parsed
  try {
    parsed = JSON.parse(workflowInput)
  } catch {
    return workflowInput
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.reviewConfig)) return workflowInput
  return JSON.stringify({ ...parsed, reviewConfig: reviewConfigForRung(parsed.reviewConfig, model) })
}

/** `~/.agentproto/config.json` with the adapter's api-key auth and model
 *  option moved to the rung. Only an existing api-key auth is rewritten. */
export function agentConfigForRung(config, adapter, rung, keyValue) {
  if (!isPlainObject(config)) return config
  const adapters = config.defaults?.adapters
  const current = isPlainObject(adapters) ? adapters[adapter] : undefined
  if (!isPlainObject(current)) return config
  const nextAdapter = { ...current }
  if (isPlainObject(current.auth) && current.auth.mode === "api-key") {
    nextAdapter.auth = { ...current.auth, apiKey: keyValue }
  }
  if (rung.model) nextAdapter.options = { ...(isPlainObject(current.options) ? current.options : {}), model: rung.model }
  return {
    ...config,
    defaults: { ...config.defaults, adapters: { ...adapters, [adapter]: nextAdapter } },
  }
}
