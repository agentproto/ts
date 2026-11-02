// Shared "sandboxed agentproto agent" block — the command-AGNOSTIC machinery
// every agentflow verb (review, pr, fix, …) composes on top of:
//
//   · sandbox placement (e2b spec: adapter install + auth env passthrough),
//   · the in-box workspace bootstrap (clone + optional PR fetch — a fresh box
//     has NO checkout and NO `gh` CLI, only git/node/npm/curl),
//   · gh-free GitHub delivery recipes (post review / open PR via curl REST),
//   · skill loading from the clone,
//   · the hard rules (no AI attribution, never echo tokens).
//
// Both `.github/agentproto-workflows/pr-review/entry.mjs` (verb: review) and
// `.github/agentproto-workflows/agent-verb/entry.mjs` (verbs: pr, fix)
// import from here, so the sandbox plumbing exists ONCE. The runner-side
// machinery (daemon boot, driver, observability, verify/fallback gating)
// lives in `.github/actions/agentproto-run/` + the calling workflows and is
// already verb-agnostic.
//
// Config source of truth: `.github/agentic-review.json`. Global keys set the
// lane (reviewerAdapter / reviewerSandbox or reviewerPlacement /
// reviewerSandboxEnv / reviewerTurnRetry); per-verb
// `commands.<verb>` overrides (skills, fixDelivery) are resolved with
// `resolveCommandConfig` — the same shallow-merge semantics as
// `scripts/lib/agent-core.mjs` (inlined here because this module runs inside
// the workflow-loader import, not the scripts toolchain).

/** `{...global, ...commands[verb]}` — per-verb keys win; `commands` removed. */
export const resolveCommandConfig = (config, verb) => {
  const base = { ...(config || {}) }
  delete base.commands
  return { ...base, ...(config?.commands?.[verb] ?? {}) }
}

/** Adapter slug for the lane (per-verb override allowed via commands.<verb>.reviewerAdapter). */
export const adapterFor = (config, verb) =>
  String(resolveCommandConfig(config, verb).reviewerAdapter || "claude-code")

/**
 * Model id override for the lane (per-verb override allowed via
 * commands.<verb>.reviewerModel) — resolved per run by the step's `model`
 * selector (same semantics as `agent_start.model`; supported on workflow
 * agent steps since #1236). Empty/absent ⇒ undefined ⇒ the adapter keeps its
 * default model.
 */
export const reviewerModelFor = (config, verb) => {
  const m = resolveCommandConfig(config, verb).reviewerModel
  return typeof m === "string" && m.trim() ? m.trim() : undefined
}

/**
 * Provision-time setup command (e2b `setupCommands`) that installs a git
 * `commit-msg` hook STRIPPING AI-attribution trailer lines, so a sandboxed
 * model's native-shell commits can't deadlock the PR against the repo's own
 * Hygiene check (issue #589). Deterministic and hook-based — NOT a prompt rule
 * the agent can ignore.
 *
 * Installed via `core.hooksPath` (global), not `.git/hooks/`, because at
 * provision time the box has NO checkout yet — the clone happens later in
 * Phase 0. A global hooks path applies to that future clone too.
 *
 * CAVEAT — this global hook is not sufficient on its own. This repo's `prepare`
 * script runs husky, which points a LOCAL `core.hooksPath` at `.husky/_`, and a
 * local hooksPath SHADOWS the global one. So the moment the box runs
 * `pnpm install` (e.g. to validate a change), this strip hook stops firing and a
 * model's `Co-Authored-By: Claude …` trailer survives — which deadlocked PR #676
 * against Hygiene. The durable backstop is the committed `.husky/commit-msg` hook
 * (same strip logic), which husky's own `_/commit-msg` wrapper execs, so coverage
 * holds under whichever hooksPath wins. Keep both: this one covers a box that
 * never installs; `.husky/commit-msg` covers one that does.
 *
 * Idempotent: the command only (re)writes the same hook file and (re)sets the
 * same config key, so re-running it never double-installs or corrupts.
 *
 * The stripped pattern mirrors `ATTRIBUTION_PATTERN` in `.github/workflows/
 * ci.yml` (case-insensitively: `Co-authored-by:.*@anthropic.com`,
 * `Co-authored-by:.*claude.ai`, `Generated with`). `grep -iv || true` keeps
 * the hook succeeding even if it filters every line.
 */
export const ATTRIBUTION_STRIP_SETUP_COMMAND = [
  `mkdir -p "$HOME/.agentproto-git-hooks"`,
  `cat > "$HOME/.agentproto-git-hooks/commit-msg" <<'HOOK'`,
  `#!/bin/sh`,
  `# Strip AI-attribution trailers so commits pass the repo Hygiene check (#589).`,
  `grep -ivE 'Co-authored-by:.*@anthropic\\.com|Co-authored-by:.*claude\\.ai|Generated with' "$1" > "$1.agentproto.tmp" || true`,
  `mv "$1.agentproto.tmp" "$1"`,
  `HOOK`,
  `chmod +x "$HOME/.agentproto-git-hooks/commit-msg"`,
  `git config --global core.hooksPath "$HOME/.agentproto-git-hooks"`,
].join("\n")

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v)

const loggedAutoLegs = new Set()
const logAutoLeg = line => {
  if (loggedAutoLegs.has(line)) return
  loggedAutoLegs.add(line)
  console.log(line)
}

/**
 * `reviewerSandbox.provider === "auto"`: computer fleet first, opt-in capped
 * overflow to e2b (`packages/runtime/src/sandbox-providers/auto.ts`).
 *
 *   · The computer leg needs `COMPUTER_CONTROLLER_URL` on THIS process (the
 *     runner exports it from the `computer-controller-url` action input). Without
 *     it (fork PR, secrets not provisioned) the spec degrades to the plain e2b
 *     spec, identical to a `provider: "e2b"` reviewerSandbox, so the reviewer
 *     runs exactly as it did before `auto` existed.
 *   · With it, the spec stays `auto` and `config.overflow.secretAllowlist` is
 *     narrowed to the names actually in this run's passthrough. The overflow
 *     refuses when an allowlisted name has no value (a run without
 *     AGENTPROTO_JOIN) or a passed name is not allowlisted, so the declared
 *     list in agentic-review.json is the ceiling, not the exact set.
 *   · AGENTPROTO_JOIN_PROVIDER defaults to the leg that is tried first, only
 *     when a join token is present (same gate as the other JOIN_* names).
 *     An overflow to e2b still reports "computer": the daemon env is fixed
 *     before the box is placed.
 */
const autoSpecFor = ({ raw, nativeConfig, nativeEnv, passthrough, sandboxConfig, hasJoinToken }) => {
  const computerUrl = process.env.COMPUTER_CONTROLLER_URL
  const hasComputer = typeof computerUrl === "string" && computerUrl.trim() !== ""
  const leg = hasComputer ? "computer" : "e2b"
  if (
    hasJoinToken &&
    !(typeof process.env.AGENTPROTO_JOIN_PROVIDER === "string" && process.env.AGENTPROTO_JOIN_PROVIDER.trim() !== "")
  ) {
    process.env.AGENTPROTO_JOIN_PROVIDER = leg
    if (!passthrough.includes("AGENTPROTO_JOIN_PROVIDER")) passthrough = [...passthrough, "AGENTPROTO_JOIN_PROVIDER"]
  }
  const { computer, fleet, e2b, residency, overflow, ...shared } = nativeConfig
  if (!hasComputer) {
    logAutoLeg(
      "reviewerSandbox auto: COMPUTER_CONTROLLER_URL is not set on this runner, using the e2b leg only",
    )
    const { config: _config, ...rest } = raw
    return {
      ...rest,
      provider: "e2b",
      config: { ...sandboxConfig, ...shared, ...(isPlainObject(e2b) ? e2b : {}) },
      env: { ...(nativeEnv ?? {}), passthrough },
    }
  }
  logAutoLeg(
    `reviewerSandbox auto: computer leg configured, overflow to e2b ${isPlainObject(overflow) && overflow.enabled === true ? "enabled" : "disabled"}`,
  )
  const narrowedOverflow =
    isPlainObject(overflow) && Array.isArray(overflow.secretAllowlist)
      ? { ...overflow, secretAllowlist: passthrough.filter(name => overflow.secretAllowlist.includes(name)) }
      : overflow
  return {
    ...raw,
    provider: "auto",
    config: {
      ...sandboxConfig,
      ...shared,
      ...(computer !== undefined ? { computer } : {}),
      ...(fleet !== undefined ? { fleet } : {}),
      ...(e2b !== undefined ? { e2b } : {}),
      ...(residency !== undefined ? { residency } : {}),
      ...(narrowedOverflow !== undefined ? { overflow: narrowedOverflow } : {}),
    },
    env: { ...(nativeEnv ?? {}), passthrough },
  }
}

const envPresent = name => typeof process.env[name] === "string" && process.env[name].trim() !== ""

const loggedLines = new Set()
const logOnce = line => {
  if (loggedLines.has(line)) return
  loggedLines.add(line)
  console.log(line)
}

const hasFleet = () => envPresent("COMPUTER_CONTROLLER_URL")

/** Sandbox provider slug of a rung's / `reviewerSandbox`'s declaration. */
const providerOf = sandbox =>
  typeof sandbox === "string" ? sandbox.trim() : isPlainObject(sandbox) && typeof sandbox.provider === "string" ? sandbox.provider.trim() : ""

/** `reviewerPlacement.ladder` of the resolved config, or undefined (also for an
 *  explicit `reviewerPlacement: null`). */
const ladderOf = cfg => {
  const ladder = isPlainObject(cfg.reviewerPlacement) ? cfg.reviewerPlacement.ladder : undefined
  return Array.isArray(ladder) && ladder.length > 0 ? ladder : undefined
}

/** The e2b declaration of the first e2b rung: what a verb with no placement
 *  support of its own (`agent-verb`, `docs-audit`) boots when the config
 *  declares a ladder instead of a plain `reviewerSandbox`. e2b is the rung
 *  every runner can place, so it is the one a single-box verb can rely on. */
const e2bRungSandbox = cfg => ladderOf(cfg)?.find(rung => providerOf(rung?.sandbox) === "e2b")?.sandbox

// ── owner-sanctioned metered models + the OpenCode Go key ───────────────────
//
// A free-tier cap is answered by a paid `opencode-go/*` model (a placement
// rung, or a `turnRetry.fallback`). The metered-model guard in ci.yml only
// inspects `reviewerModel` and `reviewerFallbackModels[0]`, so it never sees
// those ids; the SAME owner-only allowlist (`AGENT_ALLOWED_METERED_MODELS`, a
// repo variable a PR cannot set) is therefore enforced here, fail closed: a
// paid id that is not listed is dropped from the ladder / fallback list, never
// spawned.

const METERED_ALLOWLIST_ENV = "AGENT_ALLOWED_METERED_MODELS"
const GO_KEY_ENV = "OPENCODE_GO_API_KEY"
const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT"
const GO_PROVIDER = "opencode-go"

/** Same free test as the ci.yml guard: suffix `-free`, or `big-pickle`. */
const isFreeModel = model => /-free$/.test(model) || /\/big-pickle$/.test(model)

const isGoModel = model => model.startsWith(`${GO_PROVIDER}/`)

/** May a spawn route to `model`? An `opencode-go/*` id only on the opencode
 *  adapter. Free ids always; a metered id only when the
 *  owner listed it (comma / whitespace separated, exact match) and, for an
 *  `opencode-go/*` id, only when the Go key is present to pay for it. */
const modelUsable = (model, adapter) => {
  if (typeof model !== "string" || !model.trim()) return false
  const id = model.trim()
  if (isGoModel(id) && adapter !== "opencode") return false
  if (!isFreeModel(id)) {
    const allowed = (process.env[METERED_ALLOWLIST_ENV] ?? "").split(/[\s,]+/).filter(Boolean)
    if (!allowed.includes(id)) {
      logOnce(`placement: dropping metered model ${id}: not listed in ${METERED_ALLOWLIST_ENV}`)
      return false
    }
  }
  if (isGoModel(id) && !envPresent(GO_KEY_ENV)) {
    logOnce(`placement: dropping ${id}: ${GO_KEY_ENV} is not set on this runner`)
    return false
  }
  return true
}

/** Make `provider.opencode-go.options.apiKey` read `$OPENCODE_GO_API_KEY`.
 *
 *  OpenCode Zen (`opencode/*`) and Go (`opencode-go/*`) both read
 *  `OPENCODE_API_KEY`, and this lane's `api-key` input only carries ONE of the
 *  two (chosen from the primary model's route), so a Go model reached by a
 *  fallback or the paid rung needs its own variable. The inline config
 *  (`OPENCODE_CONFIG_CONTENT`, the per-session top config layer the harness
 *  merges into) points the Go provider at that variable. Written onto THIS
 *  process's env so a host session inherits it from the daemon and a boxed one
 *  receives it through `env.passthrough`. Idempotent; returns the env names that
 *  must reach the session (empty when no Go key is configured). */
const prepareGoKeyEnv = () => {
  if (!envPresent(GO_KEY_ENV)) return []
  let inline = {}
  const existing = process.env[OPENCODE_CONFIG_ENV]
  if (typeof existing === "string" && existing.trim()) {
    try {
      const parsed = JSON.parse(existing)
      if (isPlainObject(parsed)) inline = parsed
    } catch {
      // Unparseable inline config from the caller: leave it untouched rather
      // than overwrite it; the Go key then simply is not wired.
      logOnce(`placement: ${OPENCODE_CONFIG_ENV} is not valid JSON, not wiring ${GO_KEY_ENV}`)
      return []
    }
  }
  const provider = isPlainObject(inline.provider) ? inline.provider : {}
  const goProvider = isPlainObject(provider[GO_PROVIDER]) ? provider[GO_PROVIDER] : {}
  const options = isPlainObject(goProvider.options) ? goProvider.options : {}
  process.env[OPENCODE_CONFIG_ENV] = JSON.stringify({
    ...inline,
    provider: {
      ...provider,
      [GO_PROVIDER]: { ...goProvider, options: { ...options, apiKey: `{env:${GO_KEY_ENV}}` } },
    },
  })
  return [GO_KEY_ENV, OPENCODE_CONFIG_ENV]
}

/** Keep only the usable `fallback` overlays of a turnRetry policy. */
const filterTurnRetry = (policy, adapter) => {
  if (!isPlainObject(policy)) return policy
  if (!Array.isArray(policy.fallback)) return policy
  const fallback = policy.fallback.filter(o => !isPlainObject(o) || o.model === undefined || modelUsable(o.model, adapter))
  const { fallback: _dropped, ...rest } = policy
  return fallback.length > 0 ? { ...rest, fallback } : rest
}

/** Any usable `opencode-go/*` model reachable from this placement: a rung model
 *  or a turnRetry fallback. */
const goModelsIn = ({ ladder, turnRetry }) => {
  const models = []
  for (const rung of ladder ?? []) {
    if (typeof rung.model === "string") models.push(rung.model)
    for (const o of rung.turnRetry?.fallback ?? []) if (typeof o?.model === "string") models.push(o.model)
  }
  for (const o of turnRetry?.fallback ?? []) if (typeof o?.model === "string") models.push(o.model)
  return models.filter(isGoModel)
}

/**
 * Turn-retry policy for the lane's agent session (host OR boxed), read from
 * `reviewerTurnRetry` once so every workflow that spawns a reviewer shares it.
 *
 *   · key absent ⇒ undefined ⇒ the host's own default;
 *   · `null` ⇒ null ⇒ explicit opt-out;
 *   · otherwise the policy with unusable `fallback` overlays removed (see
 *     {@link modelUsable}). When a usable `opencode-go/*` fallback remains, the
 *     Go key is wired into this process's env ({@link prepareGoKeyEnv}) so a
 *     host session started after this call can reach it.
 *
 * Idempotent (selectors run more than once per step).
 */
export const reviewerTurnRetryFor = (config, verb) => {
  const cfg = resolveCommandConfig(config, verb)
  if (cfg.reviewerTurnRetry === null) return null
  if (!isPlainObject(cfg.reviewerTurnRetry)) return undefined
  const turnRetry = filterTurnRetry(cfg.reviewerTurnRetry, adapterFor(config, verb))
  if (goModelsIn({ turnRetry }).length > 0) prepareGoKeyEnv()
  return turnRetry
}

/**
 * Placement ladder for the lane's box session, from `reviewerPlacement`.
 *
 *   · no ladder configured ⇒ undefined (the caller falls back to `sandboxRefFor`);
 *   · each rung's `sandbox` is built exactly like `reviewerSandbox` (adapter
 *     auth passthrough, attribution-strip hook, join names);
 *   · a `computer` rung is dropped when this runner has no
 *     `COMPUTER_CONTROLLER_URL` (fork PR, fleet secrets not provisioned), so the
 *     review still runs on the e2b rung exactly as before the fleet existed;
 *   · a rung whose `model` is not usable ({@link modelUsable}) is dropped;
 *   · when a usable `opencode-go/*` model is reachable (a rung, or a fallback),
 *     the Go key env names are added to every surviving rung's passthrough, so
 *     the mid-run fallback works on whichever rung the session started on;
 *   · a ladder left with no rung throws: a configured review never silently
 *     degrades to a host spawn.
 */
export const reviewerPlacementFor = (config, verb) => {
  const cfg = resolveCommandConfig(config, verb)
  const ladder = ladderOf(cfg)
  if (!ladder) return undefined
  const adapter = adapterFor(config, verb)
  const turnRetry = reviewerTurnRetryFor(config, verb)
  const rungs = ladder
    .filter(rung => {
      if (providerOf(rung?.sandbox) === "computer" && !hasFleet()) {
        logOnce("placement: COMPUTER_CONTROLLER_URL is not set on this runner, skipping computer rungs")
        return false
      }
      return rung.model === undefined || modelUsable(rung.model, adapter)
    })
    .map(rung => (rung.turnRetry === undefined ? rung : { ...rung, turnRetry: filterTurnRetry(rung.turnRetry, adapter) }))
  if (rungs.length === 0) {
    throw new Error(
      "reviewerPlacement: no placement rung is usable on this runner (computer rungs need COMPUTER_CONTROLLER_URL; " +
        `a metered model needs ${METERED_ALLOWLIST_ENV}); add an e2b rung or provision the fleet`,
    )
  }
  const goEnv = goModelsIn({ ladder: rungs, turnRetry }).length > 0 ? prepareGoKeyEnv() : []
  // The join provider is fixed on the daemon env before any box is placed, so
  // it names the rung tried first (an overflow to a later rung still reports it).
  if (envPresent("AGENTPROTO_JOIN") && !envPresent("AGENTPROTO_JOIN_PROVIDER")) {
    process.env.AGENTPROTO_JOIN_PROVIDER = providerOf(rungs[0].sandbox)
  }
  return {
    ladder: rungs.map(({ sandbox, ...rest }) => ({
      sandbox: sandboxSpecFor(cfg, sandbox, goEnv),
      ...rest,
    })),
  }
}

/**
 * Sandbox placement. `reviewerSandbox` accepts two shapes:
 *
 *   · **string** (e.g. "e2b") — a provider slug; the spec is fully derived
 *     here (adapter install + attribution-strip hook + env passthrough).
 *   · **object**: a NATIVE SandboxSpec used verbatim as the base (a
 *     `provider: "auto"` object is resolved by `autoSpecFor`: it stays `auto`
 *     when this process has `COMPUTER_CONTROLLER_URL`, else degrades to plain e2b):
 *     `{ provider: "e2b", config?: {...}, env?: { passthrough?: [...] },
 *     lifecycle?: {...}, reuse?: … }`. Defaults are merged under it, never
 *     over it: if the object's `env.passthrough` is absent it falls back to
 *     `reviewerSandboxEnv`, then to `["ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN"]`
 *     (plus `"AGENTPROTO_JOIN"` when this process actually has one to offer —
 *     see the comment below `sandboxRefFor` reads it from); the setup hook +
 *     `cliVersion` pin are merged into
 *     `config` (object-provided config keys win); any other top-level keys of
 *     the object are carried through untouched — nothing is invented.
 *
 * In both shapes, absent/empty ⇒ host spawn. The spec's `env.passthrough`
 * names the
 * daemon-process env vars injected into the box — the box's own daemon +
 * adapters resolve auth from that env (there is no ~/.agentproto/config.json
 * inside a fresh box; claude-sdk reads ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN from env — proven headless in a live e2b box).
 *
 * `installPackages` (e2b): the verb's adapter package is NOT installed here —
 * the runtime auto-injects it at spawn time (#1232,
 * `sandboxAdapterBootPackages`).
 */
export const sandboxRefFor = (config, verb) => {
  const cfg = resolveCommandConfig(config, verb)
  return sandboxSpecFor(cfg, cfg.reviewerSandbox ?? e2bRungSandbox(cfg), [])
}

/** Build the spec for one raw sandbox declaration (a slug, or a native object)
 *  under an already-resolved command config. `extraPassthrough` names are
 *  appended to the winning passthrough list (the caller guarantees each one is
 *  set in this process, since a passthrough name is strict). */
const sandboxSpecFor = (cfg, raw, extraPassthrough) => {
  const slug = typeof raw === "string" ? raw.trim() : ""
  const nativeProvider =
    raw !== null && typeof raw === "object" && typeof raw.provider === "string"
      ? raw.provider.trim()
      : ""
  if (!slug && !nativeProvider) return undefined
  const nativeEnv = raw !== null && typeof raw === "object" && raw.env !== null && typeof raw.env === "object" ? raw.env : undefined
  const nativePassthrough =
    nativeEnv && Array.isArray(nativeEnv.passthrough) && nativeEnv.passthrough.length > 0
      ? nativeEnv.passthrough
      : undefined
  // AGENTPROTO_JOIN carries a home-daemon join token into the sandbox (see
  // AIP-36 `join.tokenEnv`, owned by a separate workstream — this module
  // never reads or sets that field, only the passthrough NAME below) so a
  // freshly booted CI box can dial home and register itself as a driveable
  // host. UNLIKE `join.tokenEnv` (deliberately a no-op when its value is
  // absent — see session-spawn.ts), a plain `env.passthrough` entry is a
  // STRICT slug: the sandbox boot fails loudly if it can't be resolved from
  // the daemon's own process env (`resolveSandboxSecretsEnv`). A fork PR, or
  // any run of this repo with no `AGENTPROTO_JOIN` secret configured, never
  // sets this env var — so whichever passthrough list wins below (native
  // `env.passthrough`, a configured `reviewerSandboxEnv`, or the bare
  // default) only gets the name appended when this process actually has a
  // value to give it, never unconditionally alongside ANTHROPIC_API_KEY/
  // GITHUB_TOKEN (always-required inputs to this lane, not optional). Read
  // per-call (not hoisted to module scope) so it reflects this process's
  // actual env at spec-build time.
  const hasJoinToken = typeof process.env.AGENTPROTO_JOIN === "string" && process.env.AGENTPROTO_JOIN.trim() !== ""
  // Self-reported join metadata (SANDBOX-VISIBILITY-JOIN) — `serve.ts`'s
  // `joinAsBox()` reads these into the join hello's `clientName` envelope so
  // a CI box shows up in `device_list` as more than a raw fingerprint. Same
  // gate shape as `AGENTPROTO_JOIN` itself: each is only appended when THIS
  // process (the workflow step) actually set it as a literal env var — never
  // unconditionally, so a fork PR / no-PR run / a run where the caller
  // didn't bother setting one of these stays a clean no-op for that var,
  // same as `AGENTPROTO_JOIN` itself does when the secret isn't configured.
  const JOIN_META_ENV_VARS = [
    "AGENTPROTO_JOIN_NAME",
    "AGENTPROTO_JOIN_PROVIDER",
    "AGENTPROTO_JOIN_SANDBOX_ID",
    "AGENTPROTO_JOIN_LABELS",
  ]
  const presentJoinMetaEnvVars = hasJoinToken
    ? JOIN_META_ENV_VARS.filter(
        name => typeof process.env[name] === "string" && process.env[name].trim() !== "",
      )
    : []
  const passthroughBase =
    nativePassthrough ??
    (Array.isArray(cfg.reviewerSandboxEnv) && cfg.reviewerSandboxEnv.length > 0
      ? cfg.reviewerSandboxEnv
      : ["ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN"])
  // Applied to WHICHEVER list won above (native `env.passthrough`, a
  // configured `reviewerSandboxEnv` — e.g. this repo's claude-sdk lane
  // pins `["ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN"]` — or the bare built-in
  // default): the join token is a daemon-wide capability, not specific to
  // one reviewer lane's env list, so gating it only on the unconfigured
  // default would silently disable auto-join the moment anyone (including
  // this repo, today) sets `reviewerSandboxEnv`.
  const passthrough = [
    ...passthroughBase,
    ...(hasJoinToken && !passthroughBase.includes("AGENTPROTO_JOIN") ? ["AGENTPROTO_JOIN"] : []),
    ...presentJoinMetaEnvVars.filter(name => !passthroughBase.includes(name)),
    ...extraPassthrough.filter(name => !passthroughBase.includes(name)),
  ]
  // The verb's adapter is NOT installed here anymore: the runtime
  // auto-injects the adapter boot package since #1232
  // (`sandboxAdapterBootPackages` in session-spawn.ts), so a CI-side
  // `@agentproto/adapter-<slug>@latest` install would only risk racing the
  // boot CLI update that loses it anyway.
  // Pin the boot CLI install to a known-good version so a broken
  // `@agentproto/cli@latest` publish can't silently kill the box. Only pass
  // the key when configured — the provider defaults to `@latest` otherwise.
  const cliVersion = typeof cfg.cliVersion === "string" ? cfg.cliVersion.trim() : ""
  // Provision-time commit-msg hook that strips AI-attribution trailers, so a
  // sandboxed model's native commits can't deadlock the PR against Hygiene (#589).
  const sandboxConfig = {
    setupCommands: [ATTRIBUTION_STRIP_SETUP_COMMAND],
    ...(cliVersion ? { cliVersion } : {}),
  }
  if (!slug) {
    // Native object form: the object is the verbatim base of the spec; our
    // derived defaults merge UNDER it (its own config/env keys win).
    const nativeConfig =
      raw.config !== null && typeof raw.config === "object" ? raw.config : {}
    if (nativeProvider === "auto") {
      return autoSpecFor({ raw, nativeConfig, nativeEnv, passthrough, sandboxConfig, hasJoinToken })
    }
    return {
      ...raw,
      provider: nativeProvider,
      config: { ...sandboxConfig, ...nativeConfig },
      env: { ...(nativeEnv ?? {}), passthrough },
    }
  }
  return { provider: slug, config: sandboxConfig, env: { passthrough } }
}

/** In-box working directory when sandboxed (the box workspace); undefined ⇒ run cwd. */
export const workspaceCwdFor = (config, verb) =>
  sandboxRefFor(config, verb) !== undefined ? "/home/user" : undefined

/**
 * Phase-0 workspace bootstrap for a fresh box: clone via the injected
 * GITHUB_TOKEN, optionally fetch a PR head. States up front that there is NO
 * `gh` CLI so the model never reaches for it.
 */
export const bootstrapBlock = ({ repo, baseRef = "main", prNumber }) => [
  `## Phase 0: Workspace bootstrap (you are in a fresh sandbox — no checkout exists)`,
  ``,
  `This sandbox has git, node, npm, and curl — there is NO \`gh\` CLI. Do not try to use \`gh\`; all GitHub API interactions use curl with the GITHUB_TOKEN env var (reference the env var — NEVER print its value).`,
  ``,
  `1. Clone the repo:`,
  `   \`\`\`bash`,
  `   git clone "https://x-access-token:\${GITHUB_TOKEN}@github.com/${repo}.git" repo && cd repo`,
  ...(prNumber
    ? [`   git fetch origin ${baseRef} "pull/${prNumber}/head:pr-${prNumber}" && git checkout "pr-${prNumber}"`]
    : [`   git checkout ${baseRef}`]),
  `   \`\`\``,
  `2. Run all later git/file commands from this clone${prNumber ? `; the diff base is \`origin/${baseRef}\`` : ""}.`,
  ``,
].join("\n")

/**
 * Skills, loaded FROM THE CLONE: the box can't run the runner-side skill
 * loader, but the repo it just cloned carries `.github/agent-skills/*.md` —
 * instruct the model to read the verb's configured skills before acting.
 */
export const skillsBlock = (config, verb) => {
  const skills = resolveCommandConfig(config, verb).skills ?? []
  const inRepo = skills.filter((s) => typeof s === "string" && !s.includes("/"))
  if (inRepo.length === 0) return ""
  return [
    `## Skills (read these FIRST, from your clone)`,
    ``,
    ...inRepo.map((s) => `- Read \`.github/agent-skills/${s}.md\` and follow it.`),
    ``,
  ].join("\n")
}

/**
 * Post a PR review via the shared delivery helper (write body to a file first —
 * safe JSON quoting). The helper does the REST POST AND records the created
 * review to the artifact ledger, so the runner stamps the provenance footer by
 * id instead of re-discovering the review.
 */
export const restPostReviewBlock = ({ repo, prNumber }) => [
  `   Write the review body to a file first (safe JSON quoting), then deliver it via the shared helper (which POSTs to the GitHub REST API AND records the created review to the artifact ledger so CI can stamp its provenance footer):`,
  `   \`\`\`bash`,
  `   # review.md contains your review markdown`,
  `   node -e 'const fs=require("fs");fs.writeFileSync("payload.json",JSON.stringify({event:process.argv[1],body:fs.readFileSync("review.md","utf8")}))' COMMENT`,
  `   node .github/agentproto-workflows/lib/deliver-artifact.mjs \\`,
  `     --kind review --body-file payload.json \\`,
  `     --url "https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews"`,
  `   \`\`\``,
  `   Set the first node argument to APPROVE, REQUEST_CHANGES, or COMMENT as appropriate. The helper exits 0 and prints \`created review id=…\` on success; if it exits non-zero it prints the API response — read it and retry once.`,
].join("\n")

/**
 * Author changes on a branch and OPEN A PR via curl REST — the `pr`-delivery
 * recipe shared by /pr and /fix (fixDelivery: "pr"). gh-free by design.
 */
export const restOpenPrBlock = ({ repo, branch, base, titleHint }) => [
  `   Deliver as a NEW pull request (the box has no \`gh\` — pure git + curl REST):`,
  `   \`\`\`bash`,
  `   git config user.name "agentproto-bot" && git config user.email "agentproto-bot@users.noreply.github.com"`,
  `   git checkout -b "${branch}"`,
  `   git add -A && git commit -m "<concise conventional-commit title>"`,
  `   git push origin "HEAD:${branch}"`,
  `   node -e 'const fs=require("fs");fs.writeFileSync("pr.json",JSON.stringify({title:process.argv[1],head:"${branch}",base:"${base}",body:fs.readFileSync("pr-body.md","utf8")}))' "<PR title>"`,
  `   node .github/agentproto-workflows/lib/deliver-artifact.mjs \\`,
  `     --kind pr --body-file pr.json \\`,
  `     --url "https://api.github.com/repos/${repo}/pulls"`,
  `   \`\`\``,
  `   Write \`pr-body.md\` BEFORE running the helper: what changed, why, how it was verified${titleHint ? `, and reference ${titleHint}` : ""}. Do NOT add a signature or provenance footer — the CI runner stamps a deterministic \`@agentproto-bot\` footer (session id, cost, run link) onto the PR body it just recorded.`,
  `   The helper (\`.github/agentproto-workflows/lib/deliver-artifact.mjs\`) POSTs the PR AND records it to the artifact ledger so CI can stamp by id. It exits 0 and prints \`created pr id=… number=…\` on success; if it exits non-zero it prints the API response — read it and retry once.`,
].join("\n")

/** Commit-mode delivery: push the change directly onto an existing branch. */
export const commitDeliveryBlock = ({ branch }) => [
  `   Deliver by committing DIRECTLY to the existing branch \`${branch}\`:`,
  `   \`\`\`bash`,
  `   git config user.name "agentproto-bot" && git config user.email "agentproto-bot@users.noreply.github.com"`,
  `   git add -A && git commit -m "<concise conventional-commit title>"`,
  `   git push origin "HEAD:${branch}"`,
  `   \`\`\``,
].join("\n")

/** Changeset authoring rules (shared verbatim across verbs that touch code). */
export const changesetRulesBlock = () => [
  `   Bump rules:`,
  `   - patch: bug fix, internal refactor, test, docs, CI, dependency bump`,
  `   - minor: new exported function/type/class, new optional parameter, new feature`,
  `   - major: removed/renamed export, incompatible signature change, breaking behavior`,
  `   - CI / workflow / script changes → do NOT bump any package`,
  `   - ONE frontmatter block per changeset file listing every package — a second \`---\` block is read as body, so its packages are never bumped`,
].join("\n")

/** The non-negotiables, placement-aware. */
export const hardRulesBlock = ({ sandboxed, extra = [] }) => [
  `## Hard rules`,
  ``,
  `- NEVER add AI/Claude/Anthropic attribution (no \`Co-Authored-By: ...\`, no \`Generated with ...\`) to any output, commit, or PR body.`,
  sandboxed
    ? `- There is NO \`gh\` CLI here — use curl against api.github.com with the GITHUB_TOKEN env var for every GitHub API call, and never echo the token.`
    : `- The \`gh\` CLI is already authenticated via GITHUB_TOKEN in the environment.`,
  ...extra,
].join("\n")
