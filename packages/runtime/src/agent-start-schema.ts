/**
 * `agent_start`'s input shape, extracted so every caller that lowers to an
 * `agent_start` call validates against the SAME definition: the MCP tool
 * itself (agent-tools.ts), a cron `kind:"agent"` action
 * (orchestration-tools.ts / cron-scheduler.ts) and an AIP-41 routine
 * `target.agent` (routine-registrar.ts). A new field added here works in all
 * three with no extra code.
 */

import { z } from "zod"
import { jsonTolerant } from "./json-tolerant.js"
import { sandboxSpecWithReuseSchema } from "./sandbox-spec-schema.js"
import {
  attachFieldSchema,
  commandSandboxSchema,
  contextContinuityInputSchema,
} from "./spawn-field-schemas.js"

/** MCP clients commonly stringify scalar arguments ("true"/"false"/"42").
 *  These coercers let a flag work whether the client sends a real JSON
 *  boolean/number or its string form — avoids opaque "expected boolean,
 *  received string" validation errors over the wire. */
export const mcpBool = z.preprocess(
  v => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
)
export const mcpPositiveNumber = z.preprocess(
  v => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().positive(),
)

export const agentStartInputShape = {
  adapter: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Adapter slug — one of the installed `@agentproto/adapter-*` packages " +
        "(e.g. 'claude-code', 'hermes', 'aider'). Omit only when `presetId` names " +
        "a saved preset with an adapter."
    ),
  harness: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Canonical harness slug — alias for `adapter`. Accepts the same values; " +
        "use whichever field your caller produces."
    ),
  presetId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Saved user spawn preset id from `agentproto preset list`. Its adapter and " +
        "decomposed axes are applied first; explicit fields on this call override it."
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
  origin: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Source label for this spawn — the calling channel/harness " +
        "(codex, cowork, vscode, cron, …). Descriptor-only: groups the " +
        "session under a source node in the tree. In-repo callers set it; " +
        "the mcp-bridge can auto-stamp it from the host clientInfo."
    ),
  parentSessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Parent-lineage hint: attribute this spawn to a logical parent session " +
        "so it nests under that node in the sessions tree instead of appearing " +
        "as a depth-0 root. Pass the `id` of the session doing the spawning " +
        "(e.g. an agent-to-agent `agent_start`). The child's `depth` is derived " +
        "from the parent (parent depth + 1); you don't set it. Ignored when this " +
        "call arrives through the scoped orchestrator gateway — that path derives " +
        "the parent from its own token, which always wins over this hint."
    ),
  attach: jsonTolerant(attachFieldSchema)
    .optional()
    .describe(
      "Parent-attach control, mirroring `worktree`. By DEFAULT (omitted) a " +
        "spawn attaches under the session that made it — the daemon derives " +
        "that parent from the trusted caller id, so a supervisor's executors " +
        "nest instead of appearing as depth-0 roots, no `parentSessionId` " +
        "needed. Pass `false` to launch an INDEPENDENT root (no parent) — the " +
        "deliberate detached spawn. `true` forces attach even under an " +
        "`on-request` daemon policy; `{ parent: \"<id>\" }` pins an explicit " +
        "parent. Ignored when this call arrives through the scoped " +
        "orchestrator gateway (the scope token wins). Descriptor-only lineage: " +
        "never relaxes a depth-gated worktree/role guard."
    ),
  boardId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Task-board pin for the spawned child, stamped onto its descriptor " +
        "as `meta.boardId`. The Task ledger resolves the child's default " +
        "board from this BEFORE walking `parentSessionId` lineage — so a " +
        "client spawning several depth-0 root sessions (no shared lineage) " +
        "can join them all onto ONE shared board. An explicit `boardId` " +
        "passed on a task verb still wins over this pin. Omit for the " +
        "lineage-derived `tree:<root>` default."
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Caller-declared 'this is the same logical spawn' token — a PROMISE, " +
        "not a guess. A retried agent_start call (e.g. after a slow/lost " +
        "response) that repeats the same `idempotencyKey` for the same " +
        "`adapter`+`cwd` within ~10min of a successful spawn gets that SAME " +
        "session's descriptor back instead of forking a second process — the " +
        "response carries `deduped: true` and `dedupeSource: \"explicit\"` so " +
        "you can tell. Always wins over the daemon's own derived key (see " +
        "`dedupe` below) when both would apply. Omitting this does NOT mean " +
        "'spawn unconditionally' — see `dedupe`."
    ),
  dedupe: mcpBool
    .optional()
    .describe(
      "Per-call override for the daemon's `spawn.dedupe` policy — what " +
        "happens when NO `idempotencyKey` is supplied. By DEFAULT " +
        "(`spawn.dedupe: \"always\"`) a spawn that carries a `label` gets an " +
        "IMPLICIT key derived from that label plus a hash of `prompt`, and " +
        "dedupes against it exactly like an explicit key — set " +
        "`dedupeSource: \"implicit\"` on the response (alongside `deduped: " +
        "true`) so you can tell it wasn't your own promise that matched. A " +
        "spawn with no `label` is never touched by this — deliberate " +
        "parallel fan-out into one cwd (a real, exercised pattern here) needs " +
        "no label and stays exactly as many sessions as you asked for. Pass " +
        "`dedupe: false` to opt this ONE spawn out of implicit derivation " +
        "regardless of policy — the escape hatch, mirroring `attach: false` / " +
        "`worktree: false`. `dedupe: true` forces derivation even under an " +
        "`\"on-request\"` daemon policy, mirroring `attach: true`. Unrelated and " +
        "NOT covered by this flag: a `worktree` spawn that lands in a worktree " +
        "another LIVE session already occupies under the same `label` is always " +
        "refused (`dedupeSource: \"worktree-cwd\"`) — a shared worktree, unlike a " +
        "shared plain cwd, is never a legitimate fan-out."
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
  notifyParentOnCrash: mcpBool
    .optional()
    .describe(
      "Opt this spawn into a direct in-band crash notice to its parent: if " +
        "THIS session later crashes (adapter process gone between turns), the " +
        "parent (`parentSessionId`, direct or inherited) is told via " +
        "`[child-crashed] <label/id>: <reason> — <lastError>` — enqueued " +
        "immediately if the parent is alive and idle, or queued for its next " +
        "turn (never interrupting an in-flight one) if it's busy. Default " +
        "false. The free external webhook (`notifyUrl`) already fires on any " +
        "crash regardless of this flag — this only adds the direct signal " +
        "into the parent's OWN session, for a delegating supervisor that " +
        "wants to react to a child's death without polling."
    ),
  allowSharedCwd: mcpBool
    .optional()
    .describe(
      "Acknowledge that this nested spawn WILL run in place inside its " +
        "parent's working tree even when that tree has uncommitted changes " +
        "and isn't an isolated worktree — silencing the shared-dirty-cwd " +
        "warning agent_start otherwise returns in `warnings`. Only relevant " +
        "for a delegated (depth > 0) spawn with no `worktree` and no " +
        "`sandbox`; ignored otherwise. Default false = warn."
    ),
  keepAlive: mcpBool
    .optional()
    .describe(
      "Exempt this session from the idle-reaper: it is never auto-retired " +
        "for sitting idle, no matter how long. For a supervisor that " +
        "legitimately parks — waiting on a child, waiting on a scheduled " +
        "wake — idle looks identical to finished, and the reaper would " +
        "otherwise pull it out from under you. Default false = today's " +
        "behaviour. Toggle later with `session_set_keepalive`."
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
  route: jsonTolerant(
    z.object({ gateway: z.string().min(1), baseUrl: z.string().url().optional() })
  )
    .optional()
    .describe("Billing route/gateway. This is independent of model and named access profile."),
  access: jsonTolerant(z.object({ profileRef: z.string().min(1).optional() }))
    .optional()
    .describe("Named auth profile to bill at initial spawn; resolved from the local keychain."),
  posture: z
    .string()
    .optional()
    .describe("Canonical agent posture (plan, bypass, accept-edits, read-only) or native harness mode."),
  contextProfile: z
    .string()
    .optional()
    .describe("Context intake profile (for example full or lean)."),
  auth: jsonTolerant(
    z.object({
      mode: z.enum(["subscription", "api-key"]).optional(),
      token: z.string().optional(),
      source: z.string().optional(),
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
        "this vocabulary ignore this field entirely. `source: \"claude-code-oauth\"` " +
        "(subscription mode, opt-in) instead reads the bearer FRESH on every spawn " +
        "from the local Claude Code login (Keychain / ~/.claude/.credentials.json) — " +
        "effectively self-refreshing; an explicit `token` still wins over it."
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
        args: z
          .array(z.string())
          .optional()
          .describe("`stdio` only: argv passed to the `ref` command. Ignored for `http`/`sse`."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("`stdio` only: extra environment for the launched server. Ignored for `http`/`sse`."),
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
      "Block until the spawned session's first turn completes and include the cleaned output in the response. Default false = return the descriptor immediately. " +
        "Note this blocks for the child's ENTIRE first turn (~40-90s+), not just the spawn. " +
        "Batching several `wait: true` calls in one turn does NOT run them in parallel: harnesses that execute " +
        "tool calls sequentially serialize them, each wait blocking its slot until its child's turn ends. " +
        "For parallel fan-out spawn with `wait: false` (all spawns return in seconds), then wait on completion " +
        "separately via `agentproto sessions wait <id> --until turn-end` (detached/background) or a completion " +
        "policy via `policy_attach`."
    ),
  maxCostUsd: mcpPositiveNumber
    .optional()
    .describe(
      "Hard ceiling on cumulative session cost (USD). The session is stopped at a turn-end once exceeded."
    ),
  costBudget: jsonTolerant(
    z.object({
      maxCostUsd: z.number().positive().describe("Windowed spend ceiling in USD."),
      window: z.string().min(1).describe("Rolling window spec (\"5h\"/\"7d\"/\"P7D\")."),
      scope: z.enum(["session", "profile"]).describe("Spend surface: this session, or every session on its auth profile."),
    }),
  )
    .optional()
    .describe(
      "Windowed cost-budget cap (DISTINCT from `maxCostUsd`). Auto-attaches a " +
        "governance policy that trips `policy:failed` when the rolling windowed " +
        "spend for `scope` crosses `maxCostUsd`. Never kills the session — it " +
        "trips a policy for a supervisor to act on."
    ),
  restartPolicy: jsonTolerant(
    z.object({
      on: z
        .array(z.enum(["crashed", "error"]))
        .min(1)
        .describe(
          "Which automatic death reasons trigger a restart: \"crashed\" (the " +
            "crash-detect sweep found the adapter process gone) and/or \"error\" " +
            "(an unexpected turn error with no other intentional reason). Never " +
            "restarts a clean exit, an operator kill, an idle-reap, a daemon-" +
            "restart death, or a cost-budget kill, regardless of this list."
        ),
      maxRetries: z
        .number()
        .int()
        .positive()
        .describe(
          "Rolling-window crash-loop cap: give up (leave the session dead, no " +
            "further auto-restart) once this many restarts have fired within " +
            "`windowMs`."
        ),
      windowMs: z
        .number()
        .int()
        .positive()
        .describe("Rolling window (ms) `maxRetries` counts restarts over."),
      baseDelayMs: z
        .number()
        .int()
        .positive()
        .describe("First restart's backoff delay (ms), before `factor` compounds it."),
      factor: z
        .number()
        .positive()
        .describe("Exponential backoff multiplier applied per consecutive restart."),
      maxDelayMs: z
        .number()
        .int()
        .positive()
        .describe("Backoff ceiling (ms) — the computed delay never grows past this."),
      resume: z
        .boolean()
        .optional()
        .describe(
          "Reserved for a future explicit resume-vs-fresh-spawn toggle; this PR " +
            "always revives in place (same session id, same conversation)."
        ),
    }),
  )
    .optional()
    .describe(
      "Opt-in auto-restart policy (restart-scheduler PR-2). When set, an " +
        "unexpected death (`crashed` and/or `error`, per `on`) is automatically " +
        "revived IN PLACE (reusing the resume machinery — same session id, same " +
        "conversation) after an exponential backoff, up to a rolling-window " +
        "crash-loop cap. Omit for today's behaviour: a dead session stays dead " +
        "until a human/orchestrator prompts or restarts it."
    ),
  contextContinuity: jsonTolerant(contextContinuityInputSchema)
    .optional()
    .describe(
      "Context-continuity policy for this session — controls warning, opportunistic " +
        "compaction, fresh-continuation, and hard-stop thresholds. Resolved from " +
        "global → per-adapter → explicit override."
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
  deferredTools: z
    .boolean()
    .optional()
    .describe(
      "Override deferred/lazy MCP tool loading for this spawn's daemon " +
        "self-mount: `true` hides every tool outside a small always-on " +
        "set from `tools/list` (still fully callable — use `tool_search` " +
        "to look up a hidden tool's schema by keyword before calling it), " +
        "`false` keeps the full eager surface. Omit to use the resolved " +
        "role's own default ('executor' defaults ON, since it can't " +
        "delegate anyway and rarely needs the full ~190-tool surface); " +
        "omit AND spawn a role with no opinion to fall through to the " +
        "daemon's own boot-time `defaults.mcp.deferredTools` config."
    ),
  browser: z
    .preprocess(
      // `true` is sugar for the only mode; stringified booleans tolerated.
      v => (v === true || v === "true" ? "headless" : v === "false" ? false : v),
      z.union([z.literal("headless"), z.literal(false)]),
    )
    .optional()
    .describe(
      "`\"headless\"` gives the spawned agent its own isolated headless Chrome " +
        "(1440x900, temporary profile) as a per-session `browser` MCP server " +
        "(chrome-devtools-mcp: navigate_page, take_screenshot, evaluate_script, click, " +
        "list_console_messages, …), torn down with the session (`true` = `\"headless\"`). " +
        "Works for any adapter " +
        "that mounts stdio MCP servers; runs inside the session's `commandSandbox` " +
        "(`strict` ⇒ file:// only). `false` = none. Omit to use the role / preset / " +
        "`defaults.spawn.browser` default (off). Not supported with `sandbox`."
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
          "Set `reuse` (sandboxId, ledger label, or unique sandboxId prefix — see " +
          "`agentproto sandbox list`) to reconnect to an existing sandbox instead of booting fresh."
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
        "session close so it stays reusable; set `lifecycle.destroy_on` to always kill it. " +
        "DO NOT CONFUSE with `commandSandbox` below — this field boots a WHOLE SEPARATE " +
        "machine/box; `commandSandbox` confines THIS host's own spawn argv in place. " +
        "The two are independent and combine (or not) freely; `commandSandbox` is " +
        "ignored for a `sandbox` spawn (the box's own daemon would need to apply it)."
    ),
  appServe: jsonTolerant(
    z
      .object({
        dir: z
          .string()
          .min(1)
          .describe("Absolute path to the app's directory INSIDE the sandbox box (e.g. '/home/user/apps/<slug>')."),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("Port the UI binds inside the box (default 3210). The port is exposed by the sandbox provider and its public URL returned."),
      })
      .strict(),
  )
    .optional()
    .describe(
      "WP3 — serve an agentproto app's UI from INSIDE the sandbox box and return its public " +
        "URL. Requires `sandbox` (rejected otherwise). The box daemon installs the app " +
        "(`app_install` on the in-box `dir`), launches `agentproto app serve --host 0.0.0.0 " +
        "--port <port>` detached through the box's `command_execute`, and the spawn result " +
        "+ descriptor carry `appServe: { appId, dir, port, url, ready }` — `url` is the " +
        "provider-resolved public URL for the served UI (the port is also added to the " +
        "spec's `extraPorts` and echoed in `sandboxPorts`)."
    ),
  commandSandbox: commandSandboxSchema
    .optional()
    .describe(
      "OS-level process confinement (macOS Seatbelt / Linux bubblewrap) for the " +
        "adapter's OWN spawned process on THIS host — NOT the `sandbox` field above, " +
        "which boots an entirely separate remote box. This wraps the exact argv " +
        "`adapter` spawns as (e.g. `claude`, `npx @agentclientprotocol/claude-agent-acp`) " +
        "so its process tree is denied filesystem access outside the session's `cwd` — " +
        "confinement an ACP permission seam can never provide, since it only sees tool " +
        "calls the adapter chooses to report, not what an in-process Bash actually " +
        "touches. `\"off\"` (default when omitted AND no `.agentproto/command-sandbox.json` " +
        "sets an `adapterSpawn.mode`) = unconfined, unchanged behaviour. `\"workspace\"` = " +
        "deny reads/writes to $HOME outside the workspace (protects ~/.ssh, ~/.aws, " +
        "credentials, …); network stays allowed. `\"strict\"` = `\"workspace\"` + deny all " +
        "network. A workspace can set this same axis persistently via the `adapterSpawn` " +
        "key of `.agentproto/command-sandbox.json` (a DISTINCT key from the top-level " +
        "`mode` that key file also carries for `command_execute` — the two are never " +
        "shared; misconfiguring the whole-session adapter jail is a bigger blast radius " +
        "than misconfiguring one shell command) — this param, when set, overrides that " +
        "file. Ignored for a `sandbox` spawn. `\"workspace\"`/`\"strict\"` with no backend " +
        "installed for this platform (macOS needs `sandbox-exec`, Linux needs `bwrap`) " +
        "FAILS the spawn rather than silently running unconfined."
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
          async: z
            .boolean()
            .optional()
            .describe(
              "Return a real, registered session as soon as it's minted " +
                "(status \"starting\") instead of blocking `agent_start`'s response " +
                "on `git worktree add` + the repo's setup hooks, which can run " +
                "minutes. Provisioning + the driver spawn continue in the " +
                "background; poll the session's `status` (flips to \"running\" on " +
                "success, \"error\" with a readable `lastError` on failure — it never " +
                "sits in \"starting\" forever). Any `prompt` is held and dispatched " +
                "only once the tree and the driver session both exist. Incompatible " +
                "with `wait` (there is no first-turn output to block on yet) — " +
                "combining the two is rejected. Defaults to true for any spawn that " +
                "provisions a worktree, UNLESS this call also sets `wait` (which falls " +
                "back to the old synchronous path instead of conflicting). Pass `false` " +
                "explicitly to force the old blocking ok/fail contract even without " +
                "`wait`."
            ),
        })
        .strict(),
    ])
  )
    .optional()
    .describe(
      "Isolate this session in its OWN git worktree instead of spawning " +
        "directly in `cwd` — so a parallel agent can't collide on the working " +
        "tree. `true` provisions a worktree on a fresh branch `wt/<slug>` cut " +
        "from origin/main (slug auto-minted from `label`); pass `{ slug, base, " +
        "async }` to pin either, or opt into an early return (`async`, see that " +
        "field's own description). The daemon boots the worktree (git worktree " +
        "add + the repo's agentproto.json setup hooks) and spawns `adapter` " +
        "THERE; the session's cwd, and every path it edits, live inside the " +
        "worktree. Honoured only for a ROOT spawn (a spawn made THROUGH an " +
        "orchestrator inherits its parent's tree — no second worktree; an " +
        "EXPLICIT `worktree` on such a nested spawn is REJECTED, not silently " +
        "ignored — use `sandbox` to isolate a child) and only when `cwd` " +
        "is inside a git repo (nothing to isolate otherwise ⇒ spawns plain, no " +
        "error). The daemon's `worktrees.isolation` policy may force this ON " +
        "for every root spawn (`always`) or OFF (`never`, which REJECTS an " +
        "explicit `worktree`). Ignored for a `sandbox` spawn (the box already " +
        "isolates). The worktree is NOT auto-removed on session close — it " +
        "holds the agent's work; tear it down with `agentproto worktree " +
        "rm|archive|gc`."
    ),
}

export const agentStartInputSchema = z.object(agentStartInputShape)

/** Parsed (post-coercion) `agent_start` input. */
export type AgentStartInput = z.infer<typeof agentStartInputSchema>

/**
 * `agent_start` minus the fields meaningless for a detached fire (a cron job
 * or routine has no caller to block on, so `wait` is dropped). This is what a
 * cron `kind:"agent"` action and a routine `target.agent` accept.
 */
export const detachedAgentStartSchema = agentStartInputSchema.omit({ wait: true })

export type DetachedAgentStartInput = z.infer<typeof detachedAgentStartSchema>

/**
 * Lowers detached agent-spawn fields to the `agent_start` call that performs
 * the spawn: validates them against the shared schema (so a hand-edited
 * persisted job fails loudly instead of reaching the handler unparsed) and
 * stamps `opts.origin` unless the caller set one. Throws on invalid input.
 */
export function toAgentStartCall(
  fields: unknown,
  opts: { origin?: string; context: string },
): { tool: "agent_start"; inputs: Record<string, unknown> } {
  const parsed = detachedAgentStartSchema.safeParse(fields)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    throw new Error(`${opts.context}: invalid agent_start fields: ${issues}`)
  }
  const inputs: Record<string, unknown> = { ...parsed.data }
  if (inputs.origin === undefined && opts.origin) inputs.origin = opts.origin
  return { tool: "agent_start", inputs }
}
