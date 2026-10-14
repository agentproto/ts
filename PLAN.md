# PLAN — hermes system-prompt channel via agentproto hermes plugin

Branch: `wt/hermes-system-prompt-plugin` (cut from origin/main).

## Preflight
- Read AGENTS.md. pnpm via corepack (~/bin). `pnpm install --frozen-lockfile` OK.
- `pnpm build` initially failed: `@agentproto/runtime` tsup dts worker OOM
  (ERR_WORKER_OUT_OF_MEMORY). Re-ran with `NODE_OPTIONS=--max-old-space-size=8192` → exit 0.
- `git ls-remote origin 'refs/heads/wt/system-prompt-channel'` → empty; fetch fails.
  Only `agentproto-checkpoint/wt/system-prompt-channel` exists. PR 2 branch NOT on origin
  ⇒ **section 3 (channel wiring) is deferred**; do sections 1, 2, 4, 5 only.

## 1. Plugin (Python, shipped in adapter package)
- `adapters/hermes/plugin/agentproto-system-prompt/plugin.yaml` (name/version/description)
- `adapters/hermes/plugin/agentproto-system-prompt/__init__.py`:
  - `register(ctx)`; read `AGENTPROTO_SYSTEM_PROMPT_FILE` env; unset/missing/empty → return.
  - Split text into ≤3900-char sections on paragraph boundaries when possible;
    ids `agentproto.system-prompt.00`, `.01`, … (lexical sort keeps order);
    position `after_memory`. Never raise (log + return). Python stdlib only.
- `adapters/hermes/plugin/test_agentproto_system_prompt.py` — unittest with fake ctx,
  runnable via `python3 -m unittest`.
- vitest test in `adapters/hermes/src/__tests__/` that runs the unittest via python3
  if available, else skips with a clear reason.
- package.json `files`: add `plugin`.

## 2. Install / status helpers (TS)
- `adapters/hermes/src/system-prompt-plugin.ts`:
  - `MAX_HERMES_SYSTEM_PROMPT_CHARS = 7500`
  - `hermesSystemPromptPluginStatus({ env })` → installed/enabled/installedVersion/
    bundledVersion/path. HERMES_HOME resolution; enabled = `plugins.enabled` list in
    config.yaml (line parser; unknown ⇒ false).
  - `installHermesSystemPromptPlugin({ env, enable })` — copy bundled plugin dir,
    overwrite when bundled newer; `enable` → spawn `hermes plugins enable …` (argv, no shell).
- Export from `adapters/hermes/src/index.ts`.
- CLI verb in `packages/cli/src/commands/adapters.ts`:
  `agentproto adapters hermes-plugin status|install [--enable] [--json]`.

## 3. Channel wiring — SKIPPED (PR 2 branch not pushed)

## 4. Docs
- `docs/cli/guides/app-agent-tools.md`: hermes row → plugin channel when installed+enabled,
  else prefix + warning.
- `adapters/hermes/HERMES.md`: plugin purpose, install/enable, 7500-char limit,
  section frozen at session start.

## 5. Changeset
- `pnpm changeset:ai` (fallback: hand-write `.changeset/hermes-system-prompt-plugin.md`):
  minor for `@agentproto/adapter-hermes` and `@agentproto/cli`.

## Gate
- `pnpm check-types`; vitest for touched packages; python3 unittest; commit + push
  `wt/hermes-system-prompt-plugin`. No PR. Never commit PLAN.md.
