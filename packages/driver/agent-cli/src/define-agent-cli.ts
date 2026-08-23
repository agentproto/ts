import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDoctype } from "@agentproto/define-doctype"
import { agentCliFrontmatterSchema } from "./schema.js"
import { createAcpProtocolArm } from "./protocol/acp-client.js"
import { createPrintSession } from "./protocol/print-arm.js"
import { createProprietaryProtocolArm } from "./protocol/proprietary.js"
import { composeSpawn, RuntimeConfigError } from "./manifest/compose.js"
import { wrapAgentCliSpawn } from "./command-sandbox-wrap.js"
import {
  applyModelCommand,
  createArmSessionControls,
  promptTurn,
} from "./session-controls.js"
import type {
  AgentCliClient,
  AgentCliDefinition,
  AgentCliHandle,
  AgentCliRuntime,
  AgentCliRuntimeSession,
  AgentCliStartOptions,
  SetModelResult,
  StreamEvent,
} from "./types.js"

export const defineAgentCli = createDoctype<AgentCliDefinition, AgentCliHandle>(
  {
    aip: 45,
    name: "agent-cli",
    readIdentity: (def) => def.id,
    validate(def: AgentCliDefinition) {
      const result = agentCliFrontmatterSchema.safeParse(def)
      if (!result.success) {
        throw new Error(
          `defineAgentCli (AIP-45): ${result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        )
      }

      const data = result.data

      if (data.protocol === "acp" && !data.acp) {
        throw new Error(
          "defineAgentCli (AIP-45): `acp` ref is required when protocol=acp",
        )
      }
      if (data.protocol === "mcp" && !data.mcp) {
        throw new Error(
          "defineAgentCli (AIP-45): `mcp` block is required when protocol=mcp",
        )
      }
      if (data.protocol === "proprietary" && !data.adapter) {
        throw new Error(
          "defineAgentCli (AIP-45): `adapter` package is required when protocol=proprietary",
        )
      }

      if (
        data.session?.mode === "resumable" &&
        data.capabilities?.resumable !== true
      ) {
        throw new Error(
          "defineAgentCli (AIP-45): session.mode=resumable requires capabilities.resumable: true",
        )
      }

      if (
        data.models?.apply === "arg" &&
        !data.models.bin_args_template?.length
      ) {
        throw new Error(
          "defineAgentCli (AIP-45): models.apply=\"arg\" requires models.bin_args_template",
        )
      }
    },
    build(def: AgentCliDefinition) {
      return { ...def } as AgentCliHandle
    },
  },
)

/**
 * A manifest `bin: "node"` means "run with the node that's driving THIS
 * process" (the daemon's own `process.execPath`), not "look up `node` on
 * the child's PATH". A bare `spawn("node", ...)` depends on PATH containing
 * a `node` entry — true in an interactive shell (nvm etc.) but NOT
 * guaranteed under launchd, which starts the daemon with a minimal PATH.
 * Resolving to `process.execPath` sidesteps PATH entirely for the one bin
 * value that always means "this runtime". Every other bin (npx, hermes,
 * gemini, …) is left untouched — those are meant to be resolved off PATH.
 */
function resolveSpawnBin(bin: string): string {
  return bin === "node" ? process.execPath : bin
}

export function createAgentCliRuntime(
  definition: AgentCliHandle,
): AgentCliRuntime {
  return {
    definition,
    async start(opts?: AgentCliStartOptions): Promise<AgentCliRuntimeSession> {
      const cwd = opts?.cwd ?? process.cwd()
      const resolvedBin = resolveSpawnBin(definition.bin)
      // Compose final argv + env from the manifest + per-call config.
      // Mode patches and option patches land BEFORE the host-provided
      // env so an operator-set option can be observed by the CLI even
      // when the manifest also touches the same env key (operator
      // intent wins). Validation runs here too — a misconfigured
      // operator throws RuntimeConfigError before we exec anything.
      // `contextProfile` is the one decomposed axis that still has a
      // manifest-level spawn projection.  Preserve an explicit legacy mode
      // for backwards compatibility; otherwise select the declared context
      // mode (for example claude-code's `lean`) without overloading posture
      // or route into `config.mode` again.
      const contextMode = opts?.contextProfile
        ? (definition.modes ?? []).find(
            mode => mode.id === opts.contextProfile && mode.kind === "context",
          )
        : undefined
      const config =
        opts?.config?.mode || !contextMode
          ? opts?.config
          : { ...opts?.config, mode: contextMode.id }
      const composed = composeSpawn(definition, config)
      const env: Record<string, string> = {
        ...filterStringEnv(process.env),
        ...composed.env,
      }
      // Mode-declared env scrub (AgentCliMode.env_unset): delete AFTER the
      // ambient + mode/option env are merged but BEFORE the host-provided
      // opts.env. A gateway mode (e.g. claude-code's `moonshot`) declares
      // keys that must never reach a non-native Anthropic-compatible endpoint
      // — scrubbing here is the only point where the real key is actually
      // present (compose starts from `{}` and can't delete what isn't there).
      // opts.env is applied after so an operator who explicitly forwards a
      // scrubbed key takes responsibility for it (operator intent wins).
      for (const k of composed.envUnset) delete env[k]

      // Deterministic billing-auth (AgentCliStartOptions.auth). MECHANICAL:
      // the runtime resolver already decided the provider, mode, env var to
      // SET, and vars to SCRUB — this driver imports no catalog/registry and
      // makes no policy choice, it just applies the resolved spec. EXPLICIT
      // credential selection, not scrub-by-absence: the credential is SET from
      // the resolver's named ref, never inferred from what's ambient.
      //
      // ENGAGE when the adapter enforces `always` (claude-code — every spawn,
      // preserving #312 fail-fast) OR the operator explicitly configured auth
      // (`explicit`). An unconfigured `when-configured` adapter (codex/hermes/
      // claude-sdk with no auth) does NOT engage → runs ambient, unchanged.
      const authSpec = opts?.auth
      // A gateway mode (moonshot/openrouter) or an explicit `auth_token`
      // option already injected ANTHROPIC_AUTH_TOKEN into composed.env for
      // Bearer auth against a non-Anthropic endpoint. Billing-auth
      // engagement must not run in that case: an `always`-enforcing adapter
      // (claude-code) would otherwise SET CLAUDE_CODE_OAUTH_TOKEN for
      // subscription mode alongside it — two credentials the claude binary
      // can't reconcile with a gateway ANTHROPIC_BASE_URL, and the resolved
      // spec's own conflictEnv scrub can't remove ANTHROPIC_AUTH_TOKEN
      // either (composed.env's own keys are protected from the blanket
      // scrub below, by design). The gateway's Bearer token wins outright —
      // skip engagement rather than let two auth mechanisms collide.
      //
      // Symmetric case: a `base_url` option (or gateway mode) can also be
      // set WITHOUT an `auth_token` — e.g. the caller forgot it, or it's
      // supplied a different way. `hasGatewayAuthToken` alone doesn't catch
      // this: `engageAuth` would still be true, and since the per-key scrub
      // loop below only deletes keys NOT already in `composed.env` (this
      // spawn's own base_url is protected there, by the same design as
      // above), nothing stops `env[authSpec.setEnv] = authSpec.credential`
      // from injecting a real Anthropic subscription credential
      // (CLAUDE_CODE_OAUTH_TOKEN) into a spawn whose ANTHROPIC_BASE_URL
      // points at a foreign host. An explicit gateway base_url must protect
      // against native creds leaking IN, exactly as an explicit gateway auth
      // token already protects against native creds leaking OUT — skip
      // engagement in both directions.
      const hasGatewayAuthToken = "ANTHROPIC_AUTH_TOKEN" in composed.env
      const hasGatewayBaseUrl = "ANTHROPIC_BASE_URL" in composed.env
      // A gateway route resolved BY THE RUNTIME couples its base_url with the
      // matching api-key credential in ONE spec — `authSpec.baseUrl` is set
      // ONLY on that path (resolveAuthSpec fills it exclusively in the gateway-
      // route branch, which forces api-key; a native/subscription spec never
      // carries a baseUrl). In that case the ANTHROPIC_BASE_URL now in
      // composed.env came from THIS very resolution — routed into the base_url
      // option alongside the credential — so engaging billing-auth is exactly
      // right: it injects the gateway bearer (ANTHROPIC_AUTH_TOKEN) that pairs
      // with it and scrubs the raw provider var. WITHOUT this the credential is
      // silently dropped (the `hasGatewayBaseUrl` skip below swallows it) and
      // the outbound request reaches the gateway UNAUTHENTICATED → the real
      // upstream 401s → "Authentication required" (the P0 bug). The skip guard
      // still fires for the DIFFERENT case it exists for: a base_url set
      // MANUALLY via option paired with a NATIVE spec (no `authSpec.baseUrl`),
      // where engaging would leak a native credential to a foreign host.
      const resolverCoupledGateway = authSpec?.baseUrl !== undefined
      const engageAuth =
        !!authSpec &&
        !hasGatewayAuthToken &&
        (resolverCoupledGateway || !hasGatewayBaseUrl) &&
        (authSpec.enforce === "always" || authSpec.explicit === true)
      if (authSpec && engageAuth) {
        // Scrub the conflicting credential(s)/toggles BEFORE setting this
        // mode's own credential. A key this spawn's own mode/option patch
        // explicitly SET (e.g. a gateway preset's ANTHROPIC_BASE_URL) wins
        // over the blanket scrub — composed.env is the record of keys this
        // spawn's own config explicitly assigned.
        for (const key of authSpec.unsetEnv) {
          if (!(key in composed.env)) delete env[key]
        }
        // File-based (external) subscription — codex/gemini: the CLI reads its
        // OWN local-login file (`~/.codex/auth.json`, …), so there is no bearer
        // to inject and no credential to fail-fast on. The scrub above (the
        // api-key vars) is the whole job: it stops a leftover OPENAI_API_KEY /
        // GEMINI_API_KEY from silently flipping the CLI to api-key billing under
        // a "subscription" label. Money-safe by construction — NOTHING is set
        // into any env var, so an OAuth bearer can never land in an api-key
        // channel. The host already verified the login is present (fail-loud)
        // before resolving this spec.
        // An external subscription stops here: the scrub above is the entire
        // effect. Only the inject-a-credential path continues below.
        if (!authSpec.externalCredential) {
        // Fail-fast: the credential is resolved by the HOST from a named
        // config/store ref, never read ambiently — if it didn't resolve,
        // refuse the spawn rather than silently falling back to another or an
        // ambient credential. Checked against the RESOLVED credential, not the
        // merged env, so an unrelated `opts.env` key can't paper over a
        // genuinely missing one. Message NAMES the fix instead of reciting
        // prose (kept short — the old wall-of-text overflowed the VS Code
        // notification box): when `neitherConfigured` is set, `mode` above is
        // an arbitrary fallback pick, not a real signal — a zero-credential
        // user must see BOTH paths, not just the one preference[0] happened
        // to land on (that was the bug: an api-key-only user told to buy a
        // subscription).
        if (!authSpec.credential) {
          const slug = definition.id
          const providerLabel = definition.provider ?? "<provider>"
          const configBlock =
            `{"defaults":{"adapters":{"${slug}":{"auth":{"mode":"api-key"}}}}}` +
            ` in ~/.agentproto/config.json`
          const storeHint = authSpec.ignoredApiKeyInStore
            ? ` (providers.json already has a stored key for ${providerLabel} — ignored until that block exists)`
            : ""
          const supportsSub = !!definition.authSubscription
          const message =
            authSpec.neitherConfigured && supportsSub
              ? `agent-cli '${slug}': no billing auth. Subscription → \`claude setup-token\`. ` +
                `Api-key → \`agentproto auth provider set ${providerLabel} sk-…\`${storeHint}. ` +
                `Add ${configBlock}. Never inherited from the shell.`
              : authSpec.mode === "subscription"
                ? `agent-cli '${slug}': run \`claude setup-token\` and configure the result — ` +
                  `bills the Max/Pro subscription, not API credits. Never inherited from the shell.`
                : `agent-cli '${slug}': run \`agentproto auth provider set ${providerLabel} sk-…\`` +
                  `${storeHint}, then add ${configBlock}. Never inherited from the shell.`
          throw new RuntimeConfigError("missing_auth_credential", "opts.auth.credential", message)
        }
        env[authSpec.setEnv] = authSpec.credential
        }
      }

      Object.assign(env, opts?.env ?? {})

      // claude-code's ACP wrapper never reads `--permission-mode` from argv
      // (the `bin_args_append` above is a no-op against it) — it resolves
      // `permissions.defaultMode` exclusively via `CLAUDE_CONFIG_DIR`/
      // `<cwd>/.claude/settings(.local).json`, merged through the SDK's
      // `resolveSettings`. Point a per-session `CLAUDE_CONFIG_DIR` at a
      // throwaway temp dir carrying just that one field, so a non-default
      // requested mode (e.g. "plan") actually takes effect without ever
      // touching the target repo's own `.claude` directory. A repo that
      // commits its own escalated `permissions.defaultMode` can still
      // defeat this (see resolveClaudeCodePermissionMode's doc) — that's a
      // documented limitation, not a bug in this override.
      const permissionMode = resolveClaudeCodePermissionMode(
        definition,
        opts?.posture,
        config?.mode,
      )
      // Isolation from ambient config must NOT be conditional on a
      // requested posture/mode — a caller that never passes `posture` (the
      // common case: `agent_start` / `spawnAgentSession` with no opinion on
      // permission posture) used to get NO `CLAUDE_CONFIG_DIR` override at
      // all, so the child inherited the DAEMON's own `process.env` and,
      // through it, the operator's real `~/.claude.json` — including every
      // globally-registered MCP server (e.g. an `agentproto` MCP entry
      // pointing right back at this same daemon's `agent_start`, letting an
      // unscoped one-shot worker spawn further unscoped children on its
      // own). Confirmed in production 2026-08-07: a batch worker
      // (`pmlawhub/tools/fiches/run-lane.sh`) self-spawned dozens of
      // uncontrolled child sessions this way. Verified by reading
      // `@anthropic-ai/claude-agent-sdk`'s bundled `sdk.mjs` directly: the
      // SDK resolves its GLOBAL config file (the one carrying `mcpServers`)
      // as `$CLAUDE_CONFIG_DIR/.claude.json` (falling back to
      // `$CLAUDE_CONFIG_DIR/.config.json` if present) — never the real
      // `~/.claude.json` once `CLAUDE_CONFIG_DIR` is set to anything else.
      // So isolating every claude-code spawn through this path, regardless
      // of whether a posture/mode was requested, closes the leak; only the
      // settings.json CONTENT (permissions.defaultMode) stays conditional
      // on `permissionMode` actually resolving to something.
      const isolateClaudeCodeConfig = definition.id === "claude-code"
      // Hoisted out of the `if` below so it's visible to the commandSandbox
      // wrap further down: bwrap's `--tmpfs /tmp` (`command-sandbox.ts`)
      // would otherwise HIDE this dir on Linux since it's mkdtemp'd under
      // `os.tmpdir()` BEFORE the confined spawn — it must ride along as an
      // extraWritePaths entry, not rely on the workspace bind.
      let claudeConfigDir: string | undefined
      if (isolateClaudeCodeConfig) {
        // `opts.configDir` (AgentCliStartOptions.configDir) makes the
        // isolated dir PERSISTENT instead of throwaway: the caller picks a
        // stable path (the daemon keys it per session lineage) so the SDK's
        // own conversation store — `projects/<cwd-slug>/<uuid>.jsonl`, the
        // thing `resumeSessionId` needs to find — survives adapter respawns.
        // A fresh mkdtemp per spawn is why a reaped-then-resumed session
        // used to lose native resume: the transcript sat in the previous
        // process's temp dir, and the new one minted an empty dir. The
        // isolation content below is written either way — the ISOLATION
        // invariant lives in the files, not in the dir being temporary.
        if (opts?.configDir) {
          claudeConfigDir = opts.configDir
          mkdirSync(claudeConfigDir, { recursive: true })
        } else {
          claudeConfigDir = mkdtempSync(
            join(tmpdir(), "agentproto-claude-config-"),
          )
        }
        // Explicit empty `mcpServers` rather than just leaving the global
        // config file absent — an absent file falls back to whatever the
        // SDK treats as "fresh install" defaults, which is unspecified and
        // could change; writing it makes the isolation load-bearing on our
        // own content, not on unverified fallback behavior. On a REUSED
        // persistent dir, preserve the SDK's own accumulated state (project
        // trust, onboarding flags — it rewrites this file itself) but
        // RE-ASSERT `mcpServers: {}` every spawn: a session that ran
        // `claude mcp add` mid-conversation must not smuggle that server
        // back into its next respawn — same ambient-leak surface the
        // temp-dir isolation closed (#824).
        const globalConfigPath = join(claudeConfigDir, ".claude.json")
        let priorGlobalConfig: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(readFileSync(globalConfigPath, "utf8"))
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            priorGlobalConfig = parsed as Record<string, unknown>
          }
        } catch {
          // absent or unparseable — start from the empty baseline
        }
        writeFileSync(
          globalConfigPath,
          JSON.stringify({ ...priorGlobalConfig, mcpServers: {} }),
        )
        // Isolating CLAUDE_CONFIG_DIR also shadows the operator's real
        // `~/.claude/settings.json` — including `attribution`, the key an
        // operator sets to suppress Claude Code's own default "🤖 Generated
        // with Claude Code" PR-body footer / `Co-authored-by: Claude` commit
        // trailer. A spawned session has no ambient settings.json to fall
        // back to at all once isolated, so it reverts to those CLI defaults
        // regardless of what's configured globally — confirmed on
        // agentproto/ts PR #837, opened after this isolation went
        // unconditional (#824), which carried the footer despite the
        // spawning operator's global settings disabling it. Bake the
        // suppression into every isolated settings.json unconditionally
        // rather than reading the real file back in: that would reopen
        // exactly the ambient-leak surface this isolation exists to close,
        // and make spawn output depend on whatever happens to be in the
        // runner's home dir.
        const isolatedSettings: Record<string, unknown> = {
          attribution: { commit: "", pr: "", sessionUrl: false },
        }
        if (permissionMode) {
          isolatedSettings.permissions = { defaultMode: permissionMode }
        }
        writeFileSync(
          join(claudeConfigDir, "settings.json"),
          JSON.stringify(isolatedSettings),
        )
        env.CLAUDE_CONFIG_DIR = claudeConfigDir
      }

      // The print arm spawns a fresh subprocess per turn — no
      // long-lived child, no AgentCliClient connect/events cycle.
      // Short-circuit here so buildProtocolArm is never called for it.
      if (definition.protocol === "print") {
        return createPrintSession({
          bin: resolvedBin,
          baseArgs: composed.binArgs,
          cwd,
          env,
          ...(opts?.resumeSessionId
            ? { resumeSessionId: opts.resumeSessionId }
            : {}),
          ...(opts?.mcpServers ? { mcpServers: opts.mcpServers } : {}),
          printConfig: definition.print,
          commandSandbox: opts?.commandSandbox,
          ...(claudeConfigDir ? { extraWritePaths: [claudeConfigDir] } : {}),
        })
      }

      // `proprietary` arms are not guaranteed to own a subprocess at all
      // (e.g. an in-process SDK integration) — `buildProtocolArm` decides
      // per-protocol whether `child` is required. Skip the spawn entirely
      // for `proprietary` so an in-process arm pays no subprocess cost.
      let child: ChildProcess | undefined
      const stderrBuf: string[] = []
      if (definition.protocol !== "proprietary") {
        // OS-level confinement (`AgentCliStartOptions.commandSandbox`):
        // wraps THIS spawn's argv through the same Seatbelt/bwrap backends
        // `command_execute` already uses (`@agentproto/command-sandbox`),
        // so the adapter's own process tree — not just its reported tool
        // calls — is denied out-of-workspace reads/writes. Off by default;
        // see `wrapAgentCliSpawn`'s doc for the fail-closed contract.
        const [execBin, execArgs] = await wrapAgentCliSpawn(
          resolvedBin,
          composed.binArgs,
          {
            mode: opts?.commandSandbox,
            cwd,
            ...(claudeConfigDir ? { extraWritePaths: [claudeConfigDir] } : {}),
            label: definition.id,
          },
        )
        const spawned = spawn(execBin, execArgs, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          signal: opts?.signal,
        })
        child = spawned

        // Attached synchronously, before any `await` below, so a spawn
        // failure (bad binary, PATH missing the target under a minimal
        // launchd env, …) is always observed by a listener. Node throws
        // an UNHANDLED exception — crashing this ENTIRE process, every
        // session on the box, not just this spawn — when a ChildProcess
        // emits 'error' with nobody listening. Confirmed live 2026-08-11:
        // a launchd-started daemon (PATH without the interactive shell's
        // nvm setup) hit `spawn('node') ENOENT` from an `app_run` →
        // mastra-agent spawn with no 'error' listener anywhere on the
        // chain, taking down every running session. Race 'spawn' vs
        // 'error' and turn a failure into a normal rejection instead —
        // the caller (`session-spawn.ts` / `app_run`) already turns a
        // rejected `start()` into a clean `{ok:false, message}` result.
        let spawnFailure: Error | undefined
        await new Promise<void>(resolve => {
          spawned.once("spawn", () => resolve())
          spawned.once("error", err => {
            spawnFailure = err
            resolve()
          })
        })
        if (spawnFailure) {
          const isEnoent =
            (spawnFailure as NodeJS.ErrnoException).code === "ENOENT"
          const enoentHint = isEnoent
            ? `\n'${execBin}' was not found on the daemon's PATH. If it works in your own terminal, the daemon's environment may be stale — try \`agentproto daemon restart\`.`
            : ""
          throw new Error(
            `agent-cli '${definition.id}': failed to spawn '${execBin} ${execArgs.join(" ")}': ${spawnFailure.message}${enoentHint}`,
          )
        }
        // The spawn itself succeeded — keep a listener attached for the
        // rest of the child's life so a LATER 'error' (e.g. a broken
        // pipe) never goes unhandled either.
        spawned.on("error", err => {
          stderrBuf.push(`[spawn error] ${err.message}`)
        })

        // Drain child.stderr — without this the kernel pipe buffer
        // (~64 KB on macOS / Linux) eventually fills up and blocks the
        // child mid-write, hanging the entire ACP exchange. Buffer the
        // last few KB so a downstream error event can attach the tail
        // for debugging — adapters like claude-agent-acp print useful
        // context here ("not authenticated", "model gated") that the
        // JSON-RPC reply would otherwise reduce to "Invalid params".
        const STDERR_KEEP_LINES = 80
        child.stderr?.setEncoding("utf8")
        child.stderr?.on("data", (chunk: string) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (!line) continue
            stderrBuf.push(line)
            if (stderrBuf.length > STDERR_KEEP_LINES) stderrBuf.shift()
          }
        })
      }

      const arm = await buildProtocolArm(
        definition,
        child,
        cwd,
        config?.mode,
        opts?.permissionHold ?? false,
      )
      arm._stderrTail = () => stderrBuf.join("\n")

      const abortController = new AbortController()
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => abortController.abort(), {
          once: true,
        })
      }
      // Extract model + effort from the config options so the protocol
      // arm can apply them via ACP session/set_config_option — the ACP
      // wrapper (claude-agent-acp) does not read its own CLI args and
      // forward them to claude, so bin_args_template alone is not
      // sufficient. The compose step still adds them to binArgs as a
      // best-effort fallback for non-ACP arms.
      const optModel = config?.options?.model
      const optEffort = config?.options?.effort
      // Model-selection strategy (AgentCliModels.apply, default "config"):
      //   "config"  → apply via ACP session config (set_config_option) at
      //               connect — works for claude-code.
      //   "command" → the ACP session config is a no-op on this agent
      //               (e.g. hermes silently keeps its own default), so we
      //               DON'T pass model to connect; instead we send a
      //               `/model <id>` control turn after newSession (below).
      //   "arg"     → this CLI takes its model as a CLI argument, already
      //               composed into binArgs by compose.ts before spawn — we DON'T pass
      //               model to connect() at all, same as "command".
      const modelApply = definition.models?.apply ?? "config"
      const configModel =
        optModel && modelApply === "config" ? String(optModel) : undefined
      // Mode-selection strategy (AgentCliMode.apply, default "bin_args"):
      //   "bin_args" → the mode's argv/env patch (already composed above)
      //               is how the CLI picks the mode — no ACP config to send.
      //   "config"   → the CLI has no argv/env surface for this mode (e.g.
      //               opencode's plan/build); compose.ts already skipped its
      //               bin_args/env, so forward the mode id to the ACP arm's
      //               connect({mode}) instead, applied via
      //               session/set_config_option(configId:"mode").
      const requestedModeId = config?.mode
      const requestedModeDecl = requestedModeId
        ? (definition.modes ?? []).find(m => m.id === requestedModeId)
        : undefined
      const configMode =
        requestedModeDecl?.apply === "config" ? requestedModeId : undefined
      // Caller-supplied override wins; otherwise fall back to the
      // manifest's declared default (if any) so an adapter known to drop
      // responses (e.g. hermes) gets watchdog protection without every
      // host having to opt in per spawn.
      const turnIdleTimeoutMs =
        opts?.turnIdleTimeoutMs ?? definition.session?.turn_idle_timeout_ms
      await arm.connect({
        cwd,
        env,
        abortSignal: abortController.signal,
        ...(opts?.resumeSessionId
          ? { resumeSessionId: opts.resumeSessionId }
          : {}),
        ...(opts?.mcpServers ? { mcpServers: opts.mcpServers } : {}),
        ...(configModel ? { model: configModel } : {}),
        ...(optEffort ? { effort: String(optEffort) } : {}),
        ...(configMode ? { mode: configMode } : {}),
        ...(opts?.onActivity ? { onActivity: opts.onActivity } : {}),
        ...(turnIdleTimeoutMs !== undefined ? { turnIdleTimeoutMs } : {}),
        ...(opts?.permissionHold ? { permissionHold: true } : {}),
      })

      // Derived-from-model guard: when the ACP server REJECTED the
      // connect-time model apply, the session is alive but on the agent's
      // own default model. For a free/fixed-routing adapter that's a
      // tolerable degradation (the route and bill don't change — keep
      // agentproto#186's warn-and-continue). For a
      // routeSelection:"derived-from-model" adapter (opencode, mastracode,
      // hermes, jcode) the model id IS the route: "kept the default" means
      // a DIFFERENT provider on a DIFFERENT bill than the operator named
      // (observed live: opencode spawned with a claude-code-style
      // `…@openrouter` id silently ran anthropic/claude-sonnet-4-5).
      // That's a misroute, not a preference — refuse the spawn loudly,
      // with the server's own reason and the id shape this adapter needs.
      if (
        configModel &&
        definition.routeSelection === "derived-from-model" &&
        arm.modelApplyRejection
      ) {
        const { requested, reason } = arm.modelApplyRejection
        await arm.close().catch(() => {})
        if (child && !child.killed) child.kill("SIGTERM")
        const first = definition.models?.allowed?.[0]
        const example =
          (typeof first === "string" ? first : first?.id) ??
          "openrouter/anthropic/claude-sonnet-4-6"
        throw new Error(
          `${definition.bin}: refusing to start on the default model — the requested model ` +
            `"${requested}" was rejected by the agent (${reason}). This adapter routes AND ` +
            `bills by the model id's own provider prefix, so continuing would silently run ` +
            `(and bill) a model you didn't ask for. Use the adapter's ` +
            `"<provider>/<model>" form (e.g. "${example}"), or pick an id from its model menu.`,
        )
      }

      // "command" model strategy: switch the model via a drained `/model
      // <id>` control turn. Best-effort — a failure is warned, never fatal,
      // so the session still starts (on the agent's default model).
      if (optModel && modelApply === "command") {
        await applyModelCommand(arm, String(optModel))
      }

      // Prefer the protocol-layer session id (ACP, etc.) so the host
      // can persist it for a future native-resume. Fall back to a
      // random UUID for protocols that don't model sessions — keeps
      // the field always-populated for downstream loggers.
      const sessionId = arm.sessionId ?? randomUUID()

      // The turn `cancel()` acts on. `send()` mints a fresh id per turn and
      // dropped it on the floor, which left `cancel()` with nothing to name —
      // see its comment below.
      let currentTurnId: string | undefined

      return {
        sessionId,
        pid: child?.pid,
        // Live model/mode/effort switches + the capability read-surface,
        // all pure arm delegation — shared with every host that builds
        // its own session over another transport. See session-controls.ts.
        // Snapshotted after `arm.connect()` above resolved.
        ...createArmSessionControls(arm, definition),
        send(message): AsyncIterable<StreamEvent> {
          const turnId = randomUUID()
          currentTurnId = turnId
          return promptTurn(arm, turnId, message)
        },
        /**
         * Cancel the in-flight turn — the wire equivalent of Ctrl-C at the
         * agent's own TUI, and the primitive the host's interrupt path
         * (`SessionsRegistry.interruptSession`, `{interrupt: true}`) is built
         * on.
         *
         * This used to be `abortController.abort()` alone, which cancelled
         * NOTHING: that controller is the CONNECTION-level signal, handed to
         * `arm.connect({abortSignal})` at spawn, and no arm reads it. So the
         * abort fired into the void while the agent kept working — a turn
         * "cancelled" this way ran happily to completion, and the host's 60s
         * settle-wait then timed out on a turn that was never asked to stop.
         * It only ever LOOKED like it worked for turns that happened to end
         * naturally inside that wait.
         *
         * Both arms have always implemented the real thing — the ACP arm
         * sends `session/cancel`, the print arm SIGTERMs the child — it was
         * simply never called. Call it.
         *
         * Connection-level abort deliberately stays out of this: aborting the
         * connection would end the SESSION, and cancelling a turn must leave
         * it alive and idle for the next prompt. That distinction is the whole
         * point of interrupt-vs-kill.
         */
        async cancel() {
          // No turn has been sent yet — nothing to cancel, and naming a turn
          // that never existed would be a lie to the arm.
          if (currentTurnId === undefined) return
          // Deliberately NOT cleared afterwards: a second cancel re-sends the
          // same id, and both arms are idempotent on it (ACP `session/cancel`
          // for a settled turn is a no-op; SIGTERM to an already-dead child
          // does nothing). Clearing it would instead make a cancel racing a
          // turn-end silently skip the arm — the exact no-op this whole fix
          // exists to remove.
          await arm.cancel(currentTurnId)
        },
        ...(arm.respondPermission
          ? {
              respondPermission(requestId, resolution) {
                return arm.respondPermission!(requestId, resolution)
              },
            }
          : {}),
        async close() {
          await arm.close()
          if (child && !child.killed) child.kill("SIGTERM")
        },
      }
    },
  }
}

async function buildProtocolArm(
  def: AgentCliHandle,
  child: ChildProcess | undefined,
  cwd: string,
  requestedMode?: string,
  permissionHold?: boolean,
): Promise<AgentCliClient> {
  switch (def.protocol) {
    case "acp":
      if (!child) {
        throw new Error("createAgentCliRuntime: acp protocol requires a spawned subprocess")
      }
      return createAcpProtocolArm({
        child,
        cwd,
        clientInfo: { name: def.id, version: def.version },
        requestedMode,
        ...(permissionHold ? { permissionHold: true } : {}),
      })
    case "mcp":
      throw new Error("createAgentCliRuntime: mcp protocol arm not yet implemented")
    case "proprietary":
      if (!def.adapter) {
        // defineAgentCli's validate() already enforces this for manifests
        // built through it — this guards a hand-built AgentCliHandle that
        // bypassed that check.
        throw new Error(
          "createAgentCliRuntime: proprietary protocol requires manifest.adapter",
        )
      }
      return createProprietaryProtocolArm({ adapter: def.adapter, definition: def })
    case "print":
      // Unreachable: print is handled by the early-return in start() above.
      throw new Error("createAgentCliRuntime: print arm bypasses buildProtocolArm")
  }
}

/**
 * Derives the `permissions.defaultMode` value claude-code's settings.json
 * expects for a requested AIP-45 mode, by reading the same
 * `["--permission-mode", "<value>"]` pair already declared in the
 * adapter's `modes[].bin_args_append` (one vocabulary, one source of
 * truth — see `adapters/claude-code/src/index.ts`). Scoped to
 * `definition.id === "claude-code"` since this settings-file mechanism
 * is specific to that adapter's ACP wrapper; every other adapter's
 * `bin_args_append` is applied to argv as normal and this returns
 * `undefined` for them. Also `undefined` for an unrequested mode, or a
 * mode (like "default") that has no `--permission-mode` patch — the
 * caller (`start()` above) uses that to skip writing
 * `permissions.defaultMode` into the isolated `CLAUDE_CONFIG_DIR`'s
 * `settings.json`, NOT to skip the `CLAUDE_CONFIG_DIR` override itself:
 * that override is unconditional for every claude-code spawn (see
 * `isolateClaudeCodeConfig` in `start()`) so ambient global config
 * (`~/.claude.json`, including registered `mcpServers`) never leaks into a
 * spawn that never requested a posture.
 */
function resolveClaudeCodePermissionMode(
  definition: AgentCliHandle,
  posture: string | undefined,
  configMode: string | undefined,
): string | undefined {
  if (definition.id !== "claude-code") return undefined

  // Canonical posture is a first-class axis. It deliberately does not depend
  // on the retired claude-code posture entries in `modes[]`: context profiles
  // can therefore select `lean` at the same time as a permission posture.
  // `read-only` maps to Claude Code's plan permission boundary; Claude Code
  // does not expose a stricter read-only native mode.
  const canonicalPermissionMode: Record<string, string | undefined> = {
    plan: "plan",
    "read-only": "plan",
    "accept-edits": "acceptEdits",
    bypass: "bypassPermissions",
  }
  if (posture && canonicalPermissionMode[posture]) {
    return canonicalPermissionMode[posture]
  }

  // Legacy callers that still send a single AIP-45 mode remain supported.
  if (!configMode) return undefined
  const mode = (definition.modes ?? []).find((m) => m.id === configMode)
  const args = mode?.bin_args_append ?? []
  const flagIndex = args.indexOf("--permission-mode")
  if (flagIndex === -1 || flagIndex + 1 >= args.length) return undefined
  return args[flagIndex + 1]
}

function filterStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}
