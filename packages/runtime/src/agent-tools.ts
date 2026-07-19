/**
 * MCP tools that expose agent-CLI lifecycle operations to clients.
 * Extracted from session-tools.ts as the "agent family" module.
 *
 * Lets a remote operator spawn and drive agent CLIs on the user's
 * machine through the same MCP connection they already use for fs/exec.
 *
 * Tools:
 *   agent_start   spawn a long-running agent (claude / hermes / …)
 *   agent_prompt  send a follow-up turn to a live session
 *   agent_output  tail the ring buffer
 *   agent_kill    SIGTERM the session
 *   agent_interrupt   cancel the in-flight turn, leave the session alive
 *   agent_set_model   switch a live session's model without restarting
 *   agent_set_effort  switch a live session's reasoning/compute budget
 *   agent_set_posture switch a live session's posture (native mode)
 *   agent_export  export a clean transcript
 *   agent_sessions_list   browse alive + recent agent sessions
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { AcpMcpServer } from "@agentproto/acp"
import type { SessionsRegistry } from "./sessions.js"
import {
  exportAgentSession,
  type ExportAgentSessionInput,
  type ExportAgentSessionResult,
} from "./transcript-export.js"
import type {
  AgentAdapterResolver,
  AgentAdapterLister,
  CatalogModelsLister,
} from "./http-server.js"
import { jsonTolerant } from "./json-tolerant.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import { spawnAgentSession, cleanAgentLines } from "./session-spawn.js"
import { parsePostureInput } from "./canonical-posture.js"
import { listRoles, spawnableRolesFor } from "./role.js"
import type { RoleProfile } from "./role.js"
import { loadDefaultRoleRegistry } from "./role-registry.js"
import { SandboxSpecSchema } from "@agentproto/sandbox"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import type {
  WorktreeIsolationMode,
  WorktreeProvisioner,
} from "./worktree-isolation.js"

/** `SandboxSpecSchema` plus the PR3 reuse field — `{ provider, reuse: "<sandboxId>" }`
 *  reconnects to an existing box (via `SandboxProvider.connect`) instead of
 *  booting a fresh one. Built from the same shape (rather than `.extend()`)
 *  so it stays a plain `.strict()` object independent of that schema's own
 *  extend semantics. */
const sandboxSpecWithReuseSchema = z
  .object({
    ...SandboxSpecSchema.shape,
    reuse: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Existing sandbox id (a prior session's `sandboxId`) to reconnect to instead of " +
          "booting a new box. Requires the provider to support reconnect (e.g. e2b); " +
          "omit to boot fresh (default)."
      ),
  })
  .strict()

/** Strip CSI/SGR ANSI escape sequences. Exported for test access. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

/** MCP clients commonly stringify scalar arguments ("true"/"false"/"42").
 *  These coercers let a flag work whether the client sends a real JSON
 *  boolean/number or its string form — avoids opaque "expected boolean,
 *  received string" validation errors over the wire. */
const mcpBool = z.preprocess(
  v => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
)
const mcpPositiveNumber = z.preprocess(
  v => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().positive(),
)

// ── session-id argument aliasing ──────────────────────────────────────────
// `agent_start` returns the session as `{ "id": "sess_…" }`, but the drive
// tools (`agent_prompt` / `agent_output` / `agent_kill`) historically took
// `sessionId`. Passing the natural `{ id }` shape back therefore failed with a
// Zod error, forcing a failed call per tool to learn the field name. These
// tools now accept EITHER field (additive, back-compat): `sessionId` stays the
// documented primary; `id` is a first-class alias so an agent can pipe
// `agent_start`'s return straight through.
const sessionIdField = z
  .string()
  .optional()
  .describe(
    "Session id (as returned by agent_start). Accepts either `sessionId` or " +
      "its alias `id` — pass whichever you have.",
  )
const sessionIdAliasField = z
  .string()
  .optional()
  .describe("Alias for `sessionId` — the `id` field returned by agent_start.")

/** Coalesce the `sessionId` / `id` alias pair. */
function resolveSessionIdArg(input: {
  sessionId?: string
  id?: string
}): string | undefined {
  return input.sessionId ?? input.id
}

/** Uniform error when neither `sessionId` nor `id` was supplied. */
function missingSessionIdError(tool: string): {
  content: { type: "text"; text: string }[]
  isError: true
} {
  return {
    content: [
      {
        type: "text",
        text: `${tool}: missing session id — pass \`sessionId\` (or its alias \`id\`).`,
      },
    ],
    isError: true,
  }
}

export interface RegisterAgentToolsOptions {
  registry: SessionsRegistry
  /** Optional adapter resolver — required for `agent_start`
   *  (the others work with raw spawn sessions too). When unset the
   *  start tool returns a clear error pointing at the host wiring. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Optional adapter lister — when wired, exposes `adapter_list`
   *  MCP tool. Without it the tool returns a clear "not configured"
   *  error pointing at the host wiring. */
  listAgentAdapters?: AgentAdapterLister
  /** Optional catalog lister — when wired, exposes the read-only
   *  `catalog_models` MCP tool (SPEC §5). Without it the tool returns a
   *  clear "not configured" error pointing at the host wiring. */
  listCatalogModels?: CatalogModelsLister
  /** The daemon's own plain `/mcp` gateway URL (e.g.
   *  `http://127.0.0.1:18790/mcp`). When set, `agent_start` for a
   *  `hermes` adapter with no caller-supplied `mcpServers` defaults to
   *  mounting this gateway — unlike claude-code, hermes has zero
   *  built-in tools, so omitting `mcpServers` silently produces a
   *  chat-only session with no error. An explicit `mcpServers: []` is
   *  still respected as a deliberate opt-out. Omitted → no default
   *  (today's behaviour). */
  daemonMcpUrl?: string
  /** Optional orchestrator-injection builder (WP3). When wired, the
   *  `orchestrator` field on `agent_start` mints a scoped
   *  sub-gateway token, builds the `mcpServers` entry pointing the
   *  child at `/mcp/orchestrator?scope=<token>`, and returns a
   *  `bindLifecycle` hook the handler calls (with the spawned session
   *  id) so the token is revoked when that session exits. Closed over
   *  the gateway's scope-token registry + HTTP port + session-event
   *  bus in `createGateway`. Omitted → `orchestrator` is rejected with
   *  a clear "not enabled" error. */
  buildOrchestratorMcp?: (opts: {
    tools?: readonly string[]
    /** Caller orchestrator scope (WP4) — when a child orchestrator
     *  spawns its OWN sub-orchestrator, the new token inherits depth+1
     *  and is bounded by the caller's tools (non-re-grant). */
    caller?: OrchestratorScope
    /** Override max depth for the minted child scope (clamped to the
     *  caller's, then HARD_MAX_DEPTH). */
    maxDepth?: number
    /** Override the child quota for the minted child scope (clamped to
     *  the caller's). */
    maxChildren?: number
  }) => {
    entry: AcpMcpServer
    bindLifecycle: (sessionId: string) => () => void
  }
  /** Calling orchestrator's scope (orchestrator WP4). Present ONLY on
   *  the scoped sub-gateway server (built per-request from a verified
   *  scope-token), absent on the root `/mcp` server. When present it is
   *  the identity of the orchestrator driving these tools, so:
   *    - spawns are attributed (`parentSessionId = ownerSessionId`,
   *      `depth = depth + 1`) and gated by the depth cap + child quota;
   *    - `agent_sessions_list`/`agent_kill` are restricted to the caller's
   *      subtree.
   *  Absent → full visibility, depth-0 spawns, no parent (today's root
   *  behaviour). */
  callerScope?: OrchestratorScope
  /** Optional webhook notifier — when provided, per-session `notifyUrl`
   *  values from `agent_start` are registered on spawn and
   *  unregistered on exit via the session-event bus. */
  webhookNotifier?: WebhookNotifier
  /** Loads the custom (pack-carried) role registry — forwarded to
   *  `spawnAgentSession` (gates `agent_start`) and used directly by
   *  `role_list` (the introspection-only mirror of the same data), so
   *  the two can never disagree. Defaults to `loadDefaultRoleRegistry()`
   *  (`~/.agentproto/roles/` + adapter-carried packs) when omitted;
   *  tests inject a stub registry to avoid touching the real
   *  filesystem. */
  loadRoleRegistry?: () => Promise<Record<string, RoleProfile>>
  /** Resolves an `agent_start.sandbox` slug (or an inline spec's own
   *  `.provider`) to a concrete sandbox provider handle — forwarded to
   *  `spawnAgentSession`. Omitted → `sandbox` is rejected with
   *  `sandbox_provider_not_found`. */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Provision a git worktree for an `agent_start.worktree` spawn — forwarded
   *  to `spawnAgentSession`. Injected at the composition root by a host that
   *  depends on `@agentproto/worktree` (the CLI). Omitted → a spawn the policy
   *  says to isolate is rejected with `worktree_provisioner_not_enabled`. */
  provisionWorktree?: WorktreeProvisioner
  /** Resolves the `worktrees.isolation` policy — forwarded to
   *  `spawnAgentSession`. Omitted → it reads `~/.agentproto/config.json`
   *  (env > config > `on-request`) itself. */
  resolveWorktreeIsolation?: () => Promise<WorktreeIsolationMode>
}

export function registerAgentTools(
  server: McpServer,
  opts: RegisterAgentToolsOptions
): void {
  const {
    registry,
    resolveAgentAdapter,
    listAgentAdapters,
    listCatalogModels,
    buildOrchestratorMcp,
    callerScope,
    webhookNotifier,
    daemonMcpUrl,
    loadRoleRegistry,
    resolveSandboxProvider,
    provisionWorktree,
    resolveWorktreeIsolation,
  } = opts

  // ── agent_start ────────────────────────────────────────
  server.tool(
    "agent_start",
    "Spawn a long-running agent CLI (claude-code, hermes, …) on the host. " +
      "The session stays alive across multiple turns — call `agent_prompt` " +
      "to continue the conversation. Returns the session id + initial descriptor. " +
      "When `workspaceSlug` is set, resolves the cwd via " +
      "`~/.agentproto/workspaces.json`; otherwise pass `cwd` explicitly or " +
      "fall back to the active workspace.",
    {
      adapter: z
        .string()
        .min(1)
        .describe(
          "Adapter slug — one of the installed `@agentproto/adapter-*` packages " +
            "(e.g. 'claude-code', 'hermes', 'aider')."
        ),
      workspaceSlug: z
        .string()
        .optional()
        .describe(
          "Workspace slug from `agentproto workspace list`. The daemon resolves it " +
            "to an absolute path. Omit to use the `cwd` field or the active workspace."
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute path to spawn the agent in. Wins over `workspaceSlug` when both are set."
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          "Optional initial prompt. The session is spawned and the prompt dispatched " +
            "in one shot — equivalent to `start` then `prompt` back-to-back. Skip to spawn idle."
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Free-text label that surfaces in `agent_sessions_list` and the UI — useful " +
            "for tagging sessions with a conversation id or operator name."
        ),
      mode: z
        .string()
        .optional()
        .describe(
          "Manifest-declared mode id (AIP-45 `modes`) applied at spawn time, BEFORE " +
            "the child process starts — e.g. claude-code's 'plan' (read-only: " +
            "reasons and proposes but does not edit or run commands), 'accept-edits', " +
            "'bypass-permissions'; codex's 'read-only' / 'full-access'; mastracode/" +
            "opencode's 'plan' / 'build'. Adapters that don't declare `modes` (e.g. " +
            "hermes) reject ANY value here — only pass this for adapters known to " +
            "support it. Omit for the adapter's normal interactive mode."
        ),
      idempotencyKey: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Caller-declared 'this is the same logical spawn' token. A retried " +
            "agent_start call (e.g. after a slow/lost response) that repeats the " +
            "same `idempotencyKey` for the same `adapter`+`cwd` within ~30s of a " +
            "successful spawn gets that SAME session's descriptor back instead of " +
            "forking a second process — set `deduped: true` on the response so " +
            "you can tell. Omit to spawn unconditionally (today's behaviour, and " +
            "still required for deliberate concurrent spawns into the same cwd — " +
            "this field can't distinguish a retry from an intentional duplicate " +
            "spawn, only your own declared key can). Recommended for any caller " +
            "that might retry a spawn it can't otherwise confirm succeeded."
        ),
      permissionHold: mcpBool
        .optional()
        .describe(
          "Start the session in permission-hold mode: every ACP permission " +
            "request the agent raises (Write, Bash, …) is SURFACED and HELD in " +
            "the cross-session inbox (`permissions_list` / `permissions_respond`) " +
            "instead of auto-answered, and the agent blocks until a human/" +
            "orchestrator approves or denies it. Default false = today's " +
            "auto-answer behaviour. ACP adapters only; others ignore it."
        ),
      options: jsonTolerant(
        z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
      )
        .optional()
        .describe(
          "Manifest-declared option id → value map (AIP-45 `options`), applied at " +
            "spawn time alongside `mode` — e.g. hermes' `skills` (string, prepended " +
            "before the subcommand) or a boolean flag appended when true. Each value " +
            "is validated against the option's declared `type`/`enum`/`min`/`max`; " +
            "unknown ids reject. Adapters that don't declare a given option id reject it."
        ),
      skills: jsonTolerant(z.array(z.string()))
        .optional()
        .describe(
          "Normalized, adapter-agnostic skill ids for this session (e.g. " +
            "['agentproto']). Merges with `~/.agentproto/config.json`'s " +
            "`defaults.skills` / `defaults.adapters.<slug>.skills` (global < " +
            "per-adapter < this field, which REPLACES rather than unions the " +
            "config defaults when provided — a deliberate exact set). Folded " +
            "into `options.skills` using the resolved adapter's declared " +
            "shape (e.g. hermes' comma-joined `--skills a,b`); adapters with " +
            "no declared `skills` option (e.g. claude-code, which auto-" +
            "discovers from `~/.claude/skills`) ignore this — no-op."
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Model identifier to pass to the adapter (e.g. 'claude-opus-4-8'). " +
            "For ACP adapters (claude-code) applied via session/set_config_option " +
            "after newSession — NOT via a CLI flag. Others may ignore it."
        ),
      effort: z
        .string()
        .optional()
        .describe(
          "Reasoning effort level (e.g. 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'). " +
            "IMPORTANT: effort is calibrated per model — the same label maps to different " +
            "compute budgets across models, and defaults differ by model " +
            "(Sonnet 4.6 / Opus 4.8 default 'high'; Opus 4.7 default 'xhigh'). " +
            "'max' and 'ultracode' are session-only. Omit to keep the model's own default."
        ),
      auth: jsonTolerant(
        z.object({
          mode: z.enum(["subscription", "api-key"]).optional(),
          token: z.string().optional(),
          apiKey: z.string().optional(),
        })
      )
        .optional()
        .describe(
          "Deterministic billing-auth mode + EXPLICIT credential for adapters that " +
            "declare it (today: claude-code). EXPLICIT credential selection, not " +
            "scrub-by-absence: `mode` picks 'subscription' (default) or 'api-key'; " +
            "`token`/`apiKey` (matching the resolved mode) is the secret VALUE, merged " +
            "against `~/.agentproto/config.json`'s `defaults.adapters.claude-code.auth` " +
            "(this field's `mode` wins; the credential for the resolved mode wins over " +
            "the matching config field). For claude-code, 'subscription' SETS " +
            "CLAUDE_CODE_OAUTH_TOKEN to " +
            "`token` (a bearer token minted via `claude setup-token` — bills the Max/Pro " +
            "subscription, not API credits) and DELETES ANTHROPIC_API_KEY + the cloud-" +
            "provider redirect toggles + ANTHROPIC_BASE_URL. 'api-key' SETS " +
            "ANTHROPIC_API_KEY to `apiKey` and DELETES ANTHROPIC_AUTH_TOKEN — the " +
            "deliberate 'bill the API' choice. FAILS FAST (refuses the spawn, no " +
            "fallback) when the resolved mode has no credential configured anywhere. " +
            "The secret is never logged or echoed back — only a fingerprint appears on " +
            "the session descriptor / `agent_sessions_list`. Adapters that don't declare " +
            "this vocabulary ignore this field entirely."
        ),
      mcpServers: jsonTolerant(
        z.array(
          z.object({
            name: z.string(),
            transport: z.enum(["stdio", "http", "sse"]),
            ref: z.string().optional(),
            headers: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                "Static HTTP headers sent with every request to an `http` or `sse` " +
                  "MCP server (e.g. a fixed auth token). Ignored for `stdio` transports."
              ),
            credentialRef: z
              .string()
              .optional()
              .describe(
                "Brokered credential path resolved at spawn time into additional " +
                  "`headers` (typically `Authorization`). The actual secret never lives " +
                  "in env or config; brokered headers win on collision with `headers`."
              ),
          })
        )
      )
        .optional()
        .describe(
          "MCP servers to mount into the spawned agent's session at spawn time. " +
            "Forwarded verbatim to `session/new.mcpServers` on the ACP arm — gives " +
            "the child agent a host-chosen scoped toolset (e.g. the daemon's own " +
            "orchestration gateway so it can spawn + supervise sub-agents). " +
            "Adapters that don't model MCP mounting ignore it."
        ),
      orchestrator: jsonTolerant(
        z.union([
          z.boolean(),
          z.object({
            tools: z
              .array(z.string())
              .optional()
              .describe(
                "Explicit allowlist — narrows the orchestration toolset to ⊆ the " +
                  "default subset. Names outside the default are dropped (a child " +
                  "can never widen its own scope). Omit for the full default subset."
              ),
            maxDepth: z
              .number()
              .int()
              .min(1)
              .max(8)
              .optional()
              .describe(
                "Max recursion depth reachable through this child (default 3, hard " +
                  "ceiling 8). A spawn that would exceed it is rejected. For a " +
                  "recursive spawn it can only LOWER the inherited cap, never raise it."
              ),
            maxChildren: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe(
                "Max concurrently-alive sub-agents this child may spawn (default 8). " +
                  "For a recursive spawn it can only lower the inherited quota."
              ),
          }),
        ])
      )
        .optional()
        .describe(
          "Make this child a SCOPED orchestrator — auto-mount the daemon's own " +
            "orchestration MCP tools (start/prompt/wait/poll/output + subtree " +
            "list/kill) so it can spawn and supervise its OWN sub-agents. " +
            "`true` = the default curated subset; `{ tools: [...] }` narrows it. " +
            "The daemon mints a per-child scope-token, injects the scoped " +
            "sub-gateway URL into the child's session (alongside any `mcpServers` " +
            "you pass), and revokes the token when the session exits. Shell/fs/" +
            "remote/import/terminal tools are NEVER exposed this way."
        ),
      notifyUrl: z
        .string()
        .url()
        .optional()
        .describe(
          "Optional per-session webhook URL. POSTed (fire-and-forget) on this " +
            "session's turn-end / awaiting-input / exited events, in addition to " +
            "any global notify URL."
        ),
      wait: mcpBool
        .optional()
        .describe(
          "Block until the spawned session's first turn completes and include the cleaned output in the response. Default false = return the descriptor immediately."
        ),
      maxCostUsd: mcpPositiveNumber
        .optional()
        .describe(
          "Hard ceiling on cumulative session cost (USD). The session is stopped at a turn-end once exceeded."
        ),
      role: z
        .string()
        .optional()
        .describe(
          "Spawn-time role gating whether this child may itself delegate " +
            "(spawn/drive further children) and, if it can, which roles IT " +
            "may in turn spawn. Built-ins: 'executor' = leaf, cannot " +
            "delegate — `orchestrator` is ignored and `agent_start`/" +
            "`agent_prompt` are stripped from its default toolset, " +
            "regardless of `promptAppend`. 'supervisor' = may delegate " +
            "(today's default behaviour). Custom roles installed as role " +
            "packs (see `role_list`) resolve the same way. A spawn made " +
            "THROUGH an orchestrator is additionally gated by the " +
            "privilege lattice: the calling role may only spawn a role " +
            "allowlisted in its `spawnableRoles`, or — open mode, the " +
            "default — at or below its own `level` (never something MORE " +
            "privileged than itself). Omit `role` to " +
            "derive from spawn depth (root spawns default to supervisor; " +
            "spawns made through an orchestrator default to executor — see " +
            "`defaultRoleDepthCutoff` in config.json's `defaults` block)."
        ),
      promptAppend: z
        .string()
        .optional()
        .describe(
          "One-off runtime text layered ON TOP of the resolved role's " +
            "disposition and prepended to `prompt` — it specializes the " +
            "disposition, it cannot replace it, and it cannot re-open the " +
            "tool gate (an executor asked to 'delegate anyway' via this " +
            "field still has no delegation tools)."
        ),
      trace: z
        .boolean()
        .optional()
        .describe(
          "Emit Langfuse observability traces for this session (prompt/completion + " +
            "tool spans + tokens/cost). Off by default; requires langfuse eval-reporter " +
            "creds configured."
        ),
      sandbox: jsonTolerant(
        z.union([
          z
            .string()
            .min(1)
            .describe("Sandbox provider slug from `list_sandbox_providers` (e.g. 'local', 'e2b')."),
          sandboxSpecWithReuseSchema.describe(
            "Inline AIP-36 SandboxDefinition — boots this exact spec instead of a catalog slug. " +
              "Set `reuse` to reconnect to an existing sandbox id instead of booting fresh."
          ),
        ])
      )
        .optional()
        .describe(
          "Run this session inside a sandbox instead of on the host — pass a provider " +
            "slug (see `list_sandbox_providers`) or an inline AIP-36 SandboxDefinition " +
            "object. The daemon boots the sandbox, spawns `adapter` on the box's OWN " +
            "agentproto daemon, and proxies the conversation back onto this session — " +
            "`agent_prompt`/`agent_output`/`agent_kill` behave exactly as they do for a " +
            "local spawn, and the transcript stays readable here even after the box is " +
            "torn down. Omit to run locally (default). Pass an inline spec with `reuse: " +
            "\"<sandboxId>\"` (from a prior session's `sandboxId`) to reconnect to an " +
            "existing box instead — by default such a box is PAUSED (not killed) on " +
            "session close so it stays reusable; set `lifecycle.destroy_on` to always kill it."
        ),
      worktree: jsonTolerant(
        z.union([
          mcpBool,
          z
            .object({
              slug: z
                .string()
                .regex(
                  /^[a-z0-9][a-z0-9-]*$/,
                  "slug must be lowercase kebab-case (letters, digits, hyphens)",
                )
                .optional()
                .describe(
                  "Pin the worktree's slug (names its branch `wt/<slug>` and its " +
                    "directory). Omit to auto-mint a collision-free one from the label."
                ),
              base: z
                .string()
                .min(1)
                .optional()
                .describe("Git ref the worktree branch is cut from. Default 'origin/main'."),
            })
            .strict(),
        ])
      )
        .optional()
        .describe(
          "Isolate this session in its OWN git worktree instead of spawning " +
            "directly in `cwd` — so a parallel agent can't collide on the working " +
            "tree. `true` provisions a worktree on a fresh branch `wt/<slug>` cut " +
            "from origin/main (slug auto-minted from `label`); pass `{ slug, base }` " +
            "to pin either. The daemon boots the worktree (git worktree add + the " +
            "repo's agentproto.json setup hooks) and spawns `adapter` THERE; the " +
            "session's cwd, and every path it edits, live inside the worktree. " +
            "Honoured only for a ROOT spawn (a spawn made THROUGH an orchestrator " +
            "inherits its parent's tree — no second worktree) and only when `cwd` " +
            "is inside a git repo (nothing to isolate otherwise ⇒ spawns plain, no " +
            "error). The daemon's `worktrees.isolation` policy may force this ON " +
            "for every root spawn (`always`) or OFF (`never`, which REJECTS an " +
            "explicit `worktree`). Ignored for a `sandbox` spawn (the box already " +
            "isolates). The worktree is NOT auto-removed on session close — it " +
            "holds the agent's work; tear it down with `agentproto worktree " +
            "rm|archive|gc`."
        ),
    },
    async input => {
      if (!resolveAgentAdapter) {
        return {
          content: [
            {
              type: "text",
              text:
                "agent_start is not enabled — the daemon was started without " +
                "an adapter resolver. Re-run the daemon with the `@agentproto/cli` " +
                "shim wired (see playground/scripts/gateway.ts).",
            },
          ],
          isError: true,
        }
      }
      const result = await spawnAgentSession(
        {
          registry,
          resolveAgentAdapter,
          buildOrchestratorMcp,
          daemonMcpUrl,
          callerScope,
          webhookNotifier,
          loadRoleRegistry,
          resolveSandboxProvider,
          ...(provisionWorktree ? { provisionWorktree } : {}),
          ...(resolveWorktreeIsolation ? { resolveWorktreeIsolation } : {}),
        },
        input,
      )
      if (result.ok) {
        const body = {
          ...result.descriptor,
          ...(result.output ? { output: result.output } : {}),
          ...(result.deduped ? { deduped: true } : {}),
        }
        return {
          content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
        }
      }
      // The orchestrator guardrail errors + the role-spawn gate have
      // always been reported as a structured JSON blob (error/message/
      // +details); every other failure is a plain-text message.
      // Preserved verbatim here so the MCP tool's output shape doesn't
      // change under this refactor.
      const text =
        result.code === "orchestrator_max_depth_exceeded" ||
        result.code === "orchestrator_child_quota_exceeded" ||
        result.code === "role_spawn_denied"
          ? JSON.stringify(
              { error: result.code, message: result.message, ...result.details },
              null,
              2,
            )
          : result.message
      return {
        content: [{ type: "text", text }],
        isError: true,
      }
    }
  )

  // ── agent_prompt ───────────────────────────────────────
  server.tool(
    "agent_prompt",
    "Send a follow-up prompt to a live agent session — multi-turn continuity " +
      "without re-spawning. The session id comes from `agent_start` " +
      "(or `agent_sessions_list`). Returns immediately; tail output via " +
      "`agent_output` or the SSE /sessions/:id/stream endpoint. By default, " +
      "a session mid-turn rejects the new prompt — pass `interrupt: true` to " +
      "cancel the in-flight turn and redirect the SAME session onto this " +
      "prompt instead, without losing its context (unlike `agent_kill`, " +
      "which ends the session entirely). `interrupt` is a no-op on an " +
      "already-idle session.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      prompt: z.string().min(1).describe("The next user turn (plain text)."),
      interrupt: z
        .boolean()
        .optional()
        .describe(
          "When true and the session is mid-turn, cancel the in-flight " +
            "turn and deliver this prompt on the same session instead of " +
            "rejecting. No-op when the session is already idle. Default false " +
            "(mid-turn rejects, as today)."
        ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_prompt")
      try {
        // enqueuePrompt awaits admission (resume attempt + the dead/
        // wrong-kind/busy checks) before resolving, then fires the
        // turn itself without waiting for it to drain — long turns
        // don't block this tool call. Only the awaited admission
        // phase can reject, so a dead session (killed by a daemon
        // restart, exited, errored) or a session already mid-turn
        // (and not `interrupt`ed) surfaces here as a real tool error
        // instead of a lying `{queued: true}` for a prompt that goes
        // nowhere. The caller polls agent_output for the turn's actual
        // progress/completion.
        await registry.enqueuePrompt(sessionId, input.prompt, {
          interrupt: input.interrupt,
        })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, sessionId, queued: true },
                null,
                2
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_prompt: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_output ───────────────────────────────────
  server.tool(
    "agent_output",
    "Tail the recent output of a session. Returns the last N lines of the " +
      "ring buffer (stdout + stderr inter-leaved, newest last). Use this to read " +
      "an agent's reply after `agent_prompt`.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max lines to return. Default 80, max 500."),
      clean: mcpBool
        .optional()
        .describe(
          "Strip ANSI codes and drop framing/decoration lines, returning human-readable text."
        ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_output")
      const desc = registry.get(sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text", text: `agent_output: no session "${sessionId}"` },
          ],
          isError: true,
        }
      }
      // Best-effort tail — re-attach with a temp listener, capture
      // backfill (which is the recent ring buffer), unsubscribe.
      const limit = input.lastN ?? 80
      const lines: string[] = []
      const unsub = registry.attach(sessionId, (line, _stream) => {
        lines.push(line)
      })
      if (unsub) unsub()
      const tail = lines.slice(-limit)
      let output = input.clean ? cleanAgentLines(tail) : tail
      // Resilience: a tool-busy turn emits `[tool]`/`[tool-result]` lines but
      // little or no assistant text, and clean mode strips those — so an agent
      // working hard (reading, writing files, installing) surfaces as an EMPTY
      // `lines`, which reads as "idle/stuck" to a polling orchestrator. When
      // clean output is empty but the ring HAS content, fall back to the
      // ANSI-stripped raw tail so the session's activity is always visible and
      // polling agent_output is a reliable liveness/progress signal.
      let activityFallback = false
      if (input.clean && output.length === 0 && tail.length > 0) {
        output = tail
          .map(stripAnsi)
          .map(l => l.trimEnd())
          .filter(l => l.trim().length > 0)
          .slice(-limit)
        activityFallback = output.length > 0
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId,
                status: desc.status,
                lastOutputAt: desc.lastOutputAt,
                // Distinct liveness heartbeat: advances on ANY adapter-process
                // activity (streamed thinking/text deltas, tool traffic), even
                // across a stretch where the coalesced ring emits no new LINE
                // and `lastOutputAt` looks frozen. A monitor compares the two —
                // `lastActivityAt` moving while `lastOutputAt` is stale means
                // "alive and working", not "stalled". See SessionDescriptor.
                ...(desc.lastActivityAt ? { lastActivityAt: desc.lastActivityAt } : {}),
                // processAlive is a live OS query stamped by registry.get().
                ...(desc.processAlive !== undefined ? { processAlive: desc.processAlive } : {}),
                // Surfaced so a caller can distinguish "idle" from "mid tool
                // call" without guessing from empty output.
                ...(desc.blockedOn ? { blockedOn: desc.blockedOn } : {}),
                ...(activityFallback ? { activityFallback: true } : {}),
                lines: output,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  // ── agent_kill ─────────────────────────────────────────
  server.tool(
    "agent_kill",
    "Stop a session — SIGTERM the underlying child + close the agent protocol " +
      "session. Use to free resources after the operator is done, or when a " +
      "session is wedged.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_kill")
      // Subtree scoping (WP4): on the scoped sub-gateway a child
      // orchestrator may only kill sessions in its own subtree — never
      // an arbitrary id (e.g. a sibling's, or the root operator's). Full
      // list (includeArchived) so an archived ancestor doesn't sever the
      // parent→child graph collectSubtree's BFS walks.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(sessionId)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "orchestrator_session_out_of_scope",
                    message:
                      `agent_kill: session "${sessionId}" is not in ` +
                      `your subtree — a scoped orchestrator can only kill sessions ` +
                      `it (transitively) spawned. No action taken.`,
                    ok: false,
                    sessionId,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          }
        }
      }
      const ok = registry.kill(sessionId)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId }, null, 2),
          },
        ],
      }
    }
  )

  // ── agent_interrupt ─────────────────────────────────────
  server.tool(
    "agent_interrupt",
    "Cancel the in-flight turn on a live agent session and leave the session " +
      "alive and idle. Unlike `agent_kill` (ends the session entirely), the " +
      "session stays alive and ready for the next `agent_prompt`. Unlike " +
      "`agent_prompt({interrupt: true})` (which requires a next prompt to " +
      "redirect onto), this takes no prompt — it's just stop. No-op " +
      "(`wasBusy: false`) on an already-idle or terminal session.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_interrupt")
      try {
        const { wasBusy } = await registry.interruptSession(sessionId)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, sessionId, wasBusy }, null, 2),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_interrupt: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_set_model ─────────────────────────────────────
  server.tool(
    "agent_set_model",
    "Switch the model on a LIVE agent-cli session without restarting it — " +
      "the mid-session counterpart to picking a model at `agent_start` time. " +
      "Dispatches on the adapter's own apply strategy: a session whose " +
      "adapter selects models via ACP session config or a `/model` control " +
      "turn switches live; one that takes its model as a spawn-time CLI " +
      "argument (e.g. codex) can't, and reports " +
      "`{applied:false, reason:\"requires-restart\"}` instead of failing. " +
      "Never throws on a rejected switch — check `applied` in the result.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      model: z.string().describe("Model id to switch to."),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_set_model")
      try {
        const result = await registry.setModel(sessionId, input.model)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, sessionId, ...result }, null, 2),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_set_model: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_set_effort ─────────────────────────────────────
  server.tool(
    "agent_set_effort",
    "Switch the reasoning/compute budget (effort) on a LIVE agent-cli session " +
      "without restarting it — the effort-axis counterpart to `agent_set_model`. " +
      "Applied via the adapter's ACP session config. Effort is model-dependent: " +
      "the same label means a different budget across models and some labels are " +
      "model-gated (opus offers `ultracode`, haiku doesn't), so a label the " +
      "current model rejects reports `{applied:false, reason}` instead of " +
      "failing. Never throws on a rejected switch — check `applied` in the result.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      effort: z
        .string()
        .describe(
          "Effort label to switch to (e.g. low/medium/high/xhigh/max/ultracode; " +
            "the accepted set is model-dependent).",
        ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_set_effort")
      try {
        const result = await registry.setEffort(sessionId, input.effort)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, sessionId, ...result }, null, 2),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_set_effort: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_set_posture ─────────────────────────────────────
  server.tool(
    "agent_set_posture",
    "Switch the posture (what the agent may DO — plan / accept-edits / bypass / " +
      "read-only, or a raw harness mode id) on a LIVE agent-cli session. When the " +
      "posture maps to a NATIVE mode the harness advertises, it switches live " +
      "(`applied:true`). When there is no native mode (the posture would have to " +
      "be prompt-injected or applied at spawn), it is NOT forced live — the " +
      "result is `{applied:false, reason:\"requires-restart\"}` so the caller can " +
      "re-apply it through a session restart instead. Never throws on a rejected " +
      "switch — check `applied`.",
    {
      sessionId: sessionIdField,
      id: sessionIdAliasField,
      posture: z
        .string()
        .describe(
          "Posture to switch to: a canonical value (default/plan/accept-edits/" +
            "bypass/read-only) or a raw harness mode id.",
        ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_set_posture")
      try {
        const result = await registry.setPosture(sessionId, parsePostureInput(input.posture))
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, sessionId, ...result }, null, 2),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `agent_set_posture: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── agent_sessions_list ───────────────────────────────────────
  server.tool(
    "agent_sessions_list",
    "List agent-CLI sessions tracked by the daemon. Equivalent to `session_list({kind: 'agent-cli'})`. " +
      "Each entry includes `kind`, `status`, age, etc. Use this when you only want " +
      "the agent-CLI subset.",
    {
      kind: z
        .enum(["terminal", "agent-cli", "command", "all"])
        .optional()
        .describe(
          "Optional override of the default `agent-cli` filter. `all` returns every kind."
        ),
      onlyAlive: z
        .boolean()
        .optional()
        .describe("When true, only running/starting sessions. Default false."),
      status: z
        .enum(["starting", "running", "exited", "killed", "error"])
        .optional()
        .describe("Filter by exact status (overrides onlyAlive)."),
    },
    async input => {
      // Full list (includeArchived) for subtree correctness — see
      // session_list's docblock; archived rows are hidden below,
      // unconditionally (this tool has no includeArchived opt-in).
      let rows = registry.list({ includeArchived: true })
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      rows = rows.filter(s => !s.archived)
      const kind = input.kind ?? "agent-cli"
      if (kind !== "all") {
        rows = rows.filter(s => s.kind === kind)
      }
      if (input.status) {
        rows = rows.filter(s => s.status === input.status)
      } else if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ sessions: rows }, null, 2) },
        ],
      }
    },
  )

  // ── adapter_list ──────────────────────────────────────────────
  server.tool(
    "adapter_list",
    "Enumerate every agent CLI adapter installed on the host (claude-code, " +
      "hermes, aider, …). Returns slug + display name + version + protocol so " +
      "callers can let users pick from the installed set instead of guessing. " +
      "Use before `agent_start` when the model doesn't already know " +
      "what's available.",
    {},
    async () => {
      if (!listAgentAdapters) {
        return {
          content: [
            {
              type: "text",
              text:
                "adapter_list is not enabled — the daemon was started without " +
                "an adapter lister. Wire `@agentproto/cli`'s " +
                "`listInstalledAdapters` via `createGateway({ listAgentAdapters })`.",
            },
          ],
          isError: true,
        }
      }
      try {
        const adapters = await listAgentAdapters()
        return {
          content: [{ type: "text", text: JSON.stringify({ adapters }, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `adapter_list failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── catalog_models ────────────────────────────────────────────
  server.tool(
    "catalog_models",
    "Read-only vendor/product/route catalog (SPEC §5) — every model this " +
      "host can reach, widened beyond any one adapter's model list via " +
      "OpenRouter/Requesty/HuggingFace routing, with a profile-aware " +
      "`runnable` flag per route. Use before `agent_start` to see what's " +
      "actually spawnable given the auth profiles configured on this host.",
    {
      adapter: z.string().optional().describe("Keep only routes reachable via this adapter slug."),
      vendor: z.string().optional().describe("Keep only this vendor's entry."),
      route: z.string().optional().describe("Keep only routes with this route id."),
      runnableOnly: mcpBool.optional().describe("Drop every route with runnable:false."),
    },
    async ({ adapter, vendor, route, runnableOnly }) => {
      if (!listCatalogModels) {
        return {
          content: [
            {
              type: "text",
              text:
                "catalog_models is not enabled — the daemon was started without " +
                "a catalog lister. Wire `buildCatalogModels` via " +
                "`createGateway({ listCatalogModels })`.",
            },
          ],
          isError: true,
        }
      }
      try {
        const catalog = await listCatalogModels({
          ...(adapter ? { adapter } : {}),
          ...(vendor ? { vendor } : {}),
          ...(route ? { route } : {}),
          ...(runnableOnly ? { runnableOnly: true } : {}),
        })
        return {
          content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `catalog_models failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── role_list ─────────────────────────────────────────────────
  server.tool(
    "role_list",
    "Enumerate every spawn-time role known to the daemon — the two " +
      "built-ins (executor, supervisor) plus any custom role installed as " +
      "a role pack. Read-only: pure visibility into the same registry " +
      "`agent_start`'s `role` field and privilege-lattice spawn gate use — " +
      "this tool never itself grants or denies a spawn. Use before " +
      "`agent_start` with `orchestrator` to discover which roles this " +
      "session may in turn spawn.",
    {},
    async () => {
      try {
        const registry = loadRoleRegistry ? await loadRoleRegistry() : await loadDefaultRoleRegistry()
        const roles = listRoles(registry).map(role => ({
          name: role.name,
          level: role.level,
          delegation: role.toolPolicy.delegation,
          spawnable: spawnableRolesFor(role, registry).map(child => child.name),
        }))
        return {
          content: [{ type: "text", text: JSON.stringify({ roles }, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `role_list failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )
}

export interface ExportSessionOps {
  registry: SessionsRegistry
  /**
   * Override the export function — primarily for testing so callers can inject
   * a stub without needing real JSONL / SQLite fixtures.
   */
  exportFn?: (input: ExportAgentSessionInput) => Promise<ExportAgentSessionResult>
}

/**
 * Register the `agent_export` MCP tool.
 *
 * Wraps `exportAgentSession` from transcript-export.ts. Resolves the session
 * descriptor via the registry (same registry-access pattern as `summarize_session`)
 * then delegates to the per-adapter exporter (claude-code JSONL / hermes SQLite).
 * Returns the rendered transcript as a text content block.
 */
export function registerExportSessionTool(server: McpServer, ops: ExportSessionOps): void {
  const doExport = ops.exportFn ?? exportAgentSession
  server.tool(
    "agent_export",
    "Export a clean, human-readable transcript of an agent session. " +
      "Prefers the source the adapter already persists (claude-code: JSONL in " +
      "~/.claude/projects/; hermes: state.db in ~/.hermes/), falling back to " +
      "agentproto's own daemon-captured events.jsonl for every other adapter " +
      "(or once the native store is unreadable). Returns markdown (default) or " +
      "JSON. Works on stopped and running sessions alike. Use after a long " +
      "agent run to review the full conversation without the ANSI noise of the " +
      "ring buffer.",
    {
      sessionId: z
        .string()
        .optional()
        .describe(
          "agentproto session id (sess_xxx), adapter-native id, or session name. " +
            "Accepts either `sessionId` or its alias `id`.",
        ),
      id: sessionIdAliasField,
      adapter: z.string().optional().describe(
        "Override adapter slug (e.g. 'claude-code', 'hermes') when the session " +
          "is not in the registry. Required when passing a raw adapter-native id."
      ),
      cwd: z.string().optional().describe(
        "Override cwd (absolute path) — required for claude-code when the session " +
          "is not in the registry (used to locate the JSONL file)."
      ),
      format: z.enum(["markdown", "json"]).optional().describe(
        "Output format. `markdown` (default) renders a human-friendly transcript " +
          "with a metadata table and role-labelled messages; `json` returns the raw " +
          "ExportedSession object for programmatic processing."
      ),
      source: z.enum(["auto", "native", "daemon"]).optional().describe(
        "Which backend to read from. `auto` (default) prefers the adapter's own " +
          "native store (claude-code JSONL / hermes SQLite) and falls back to " +
          "agentproto's own events.jsonl capture when there isn't one; `native` / " +
          "`daemon` force one and surface its own error instead of falling back."
      ),
    },
    async input => {
      const sessionId = resolveSessionIdArg(input)
      if (!sessionId) return missingSessionIdError("agent_export")
      const result = await doExport({
        sessionId,
        registry: ops.registry,
        ...(input.adapter ? { adapter: input.adapter } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.source ? { source: input.source } : {}),
      })
      const isError = result.content.startsWith("Error:")
      return {
        content: [{ type: "text" as const, text: result.content }],
        ...(isError ? { isError: true as const } : {}),
      }
    },
  )
}

/**
 * Compute the set of session ids in the subtree rooted at `rootId` —
 * the root itself plus every descendant reachable through the
 * `parentSessionId` chain (orchestrator WP4). Used to scope
 * `list`/`kill` on the scoped sub-gateway so a child orchestrator only
 * ever sees/affects the sessions it (transitively) spawned, never the
 * whole daemon. Returns an empty set when `rootId` is undefined (an
 * unbound scope sees nothing — safe default).
 *
 * Shared between agent-tools.ts and session-tools.ts; declared here so
 * both modules can use it without an extra util file for this PR.
 */
export function collectSubtree(
  rootId: string | undefined,
  all: readonly import("./sessions.js").SessionDescriptor[],
): Set<string> {
  const result = new Set<string>()
  if (!rootId) return result
  const childrenOf = new Map<string, string[]>()
  for (const s of all) {
    if (!s.parentSessionId) continue
    const arr = childrenOf.get(s.parentSessionId)
    if (arr) arr.push(s.id)
    else childrenOf.set(s.parentSessionId, [s.id])
  }
  const queue = [rootId]
  result.add(rootId)
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const child of childrenOf.get(id) ?? []) {
      if (!result.has(child)) {
        result.add(child)
        queue.push(child)
      }
    }
  }
  return result
}
