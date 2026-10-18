/**
 * `agent_start`'s input shape, extracted so every caller that lowers to an
 * `agent_start` call validates against the SAME definition: the MCP tool
 * itself (agent-tools.ts), a cron `kind:"agent"` action
 * (orchestration-tools.ts / cron-scheduler.ts) and an AIP-41 routine
 * `target.agent` (routine-registrar.ts). A new field added here works in all
 * three with no extra code.
 *
 * Field descriptions here are deliberately short — the contract, not the
 * manual. Full detail (edge cases, cross-field interactions, examples) lives
 * in `docs/mcp-tools/agent_start.md`, one `##` section per field, fetched on
 * demand via `tool_help {name:"agent_start", topic:"<field>"}`.
 */

import { z } from "zod"
import { jsonTolerant } from "./json-tolerant.js"
import { turnRetryInputSchema } from "./turn-retry-policy.js"
import { sandboxSpecWithReuseSchema } from "./sandbox-spec-schema.js"
import { sandboxCheckpointOverrideSchema } from "./sandbox-checkpoint-schema.js"
import {
  attachFieldSchema,
  commandSandboxSchema,
  contextContinuityInputSchema,
  promptInputSchema,
} from "./spawn-field-schemas.js"
import { decodeWhsecSecret } from "./webhook-egress/signing.js"

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

/** `Details: tool_help {name:"agent_start", topic:"<field>"}` — shared
 *  suffix so every field's pointer stays byte-identical. */
const help = (field: string) => `Details: tool_help {name:"agent_start", topic:"${field}"}`

/**
 * ONE MCP-server-mount entry — the shape both `agent_start.mcpServers` (below)
 * and the restart-override paths (`session_restart` MCP verb + the
 * `POST /sessions/:id/restart` route, via {@link mcpServerMountsOverrideSchema})
 * validate against, so they can't drift.
 */
export const mcpServerMountEntrySchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "http", "sse"]),
  ref: z.string().optional(),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Static HTTP headers for `http`/`sse` transports. Ignored for `stdio`."),
  credentialRef: z
    .string()
    .optional()
    .describe(
      "Brokered credential resolved into `headers` at mount time (wins on " +
        "collision with `headers`); the secret never lives in env/config."
    ),
  args: z
    .array(z.string())
    .optional()
    .describe("`stdio` only: argv passed to the `ref` command."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("`stdio` only: extra environment for the launched server."),
})

/**
 * A full mcpServers list for a RESTART override. Every entry must carry a
 * `ref` (the transport's URL or command — an entry without one would mount a
 * broken server the agent can never call); fail-loud instead.
 */
export const mcpServerMountsOverrideSchema = z
  .array(mcpServerMountEntrySchema)
  .superRefine((entries, ctx) => {
    entries.forEach((entry, i) => {
      if (entry.ref === undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            `mcpServers[${i}] ("${entry.name}", ${entry.transport}) requires a ` +
            "`ref` — the URL the `http`/`sse` mount points at, or the command " +
            "a `stdio` mount launches. An entry without one cannot be mounted.",
          path: [i, "ref"],
        })
      }
    })
  })

export const agentStartInputShape = {
  adapter: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Adapter slug (e.g. 'claude-code', 'hermes', 'aider'). Omit only when " +
        `\`presetId\` supplies one. ${help("adapter")}`
    ),
  harness: z
    .string()
    .min(1)
    .optional()
    .describe(`Alias for \`adapter\` — same values, whichever your caller produces.`),
  presetId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Saved spawn preset id from `agentproto preset list`. Explicit fields " +
        "on this call override its values."
    ),
  workspaceSlug: z
    .string()
    .optional()
    .describe(
      "Workspace slug (`agentproto workspace list`) resolved to a path; with " +
        "`sandbox`, its remote is cloned into the box. " +
        "Omit to use `cwd` or the active workspace."
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute spawn path. Wins over `workspaceSlug` except with " +
        "`sandbox` + `workspaceSlug`: then a path inside the box. " +
        help("cwd")
    ),
  prompt: promptInputSchema
    .optional()
    .describe(
      "Optional initial prompt — spawn + dispatch in one call; omit to spawn idle. A plain " +
        "string is composed with the role/AGENTS.md preamble; a content block/" +
        "array (e.g. a pasted image) SKIPS composition and is sent verbatim — " +
        "the adapter negotiates its own multimodal support. " +
        help("prompt")
    ),
  label: z
    .string()
    .optional()
    .describe("Free-text label shown in `agent_sessions_list` and the UI."),
  mode: z
    .string()
    .optional()
    .describe(
      "Manifest-declared mode id (AIP-45 `modes`), applied before the child " +
        "starts (e.g. claude-code 'plan'/'accept-edits'). Adapters with no " +
        `declared \`modes\` reject any value. ${help("mode")}`
    ),
  origin: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Source label for this spawn (codex, cowork, vscode, cron, …) — " +
        "descriptor-only, groups the session under a source node in the tree."
    ),
  parentSessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Parent-lineage hint: nests this spawn under that session in the tree " +
        `instead of a depth-0 root. Ignored through the scoped orchestrator ` +
        `gateway (its own token wins). ${help("parentSessionId")}`
    ),
  attach: jsonTolerant(attachFieldSchema)
    .optional()
    .describe(
      "Parent-attach override, mirrors `worktree`: default attaches under the " +
        "calling session; `false` = independent root; `true` forces; " +
        `\`{ parent: "<id>" }\` pins an explicit parent. ${help("attach")}`
    ),
  boardId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Task-board pin for the child (`meta.boardId`), resolved before " +
        `parent-lineage. An explicit board on a task verb still wins. ${help("boardId")}`
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Caller-declared dedup token: same key for the same `adapter`+`cwd` " +
        "within ~10min of a successful spawn returns that SAME session " +
        `(\`deduped: true\`). Always wins over the implicit key \`dedupe\` derives. ${help("idempotencyKey")}`
    ),
  dedupe: mcpBool
    .optional()
    .describe(
      "Overrides the implicit dedup-by-`label` default (active when no " +
        "`idempotencyKey` is given): `false` opts out, `true` forces even " +
        `under an "on-request" daemon policy. ${help("dedupe")}`
    ),
  permissionHold: mcpBool
    .optional()
    .describe(
      "Hold ACP permission requests in the cross-session inbox " +
        "(`permissions_list`/`permissions_respond`) instead of auto-answering. " +
        "ACP adapters only; default false."
    ),
  notifyParentOnCrash: mcpBool
    .optional()
    .describe(
      "Notify this session's parent (in-band) if it later crashes, " +
        `independent of the global \`notifyUrl\` webhook. ${help("notifyParentOnCrash")}`
    ),
  sentinel: mcpBool
    .optional()
    .describe(
      "`false` opts this spawn out of AIP-60 sentinel auto-link: a PR this " +
        "session opens gets no automatic watcher, regardless of the daemon's " +
        `\`sentinel.autoWatchPrs\` config. ${help("sentinel")}`
    ),
  allowSharedCwd: mcpBool
    .optional()
    .describe(
      "Acknowledge a nested spawn in the parent's dirty working tree, " +
        "silencing the shared-dirty-cwd warning. Only relevant without " +
        "`worktree`/`sandbox`; default false = warn."
    ),
  keepAlive: mcpBool
    .optional()
    .describe(
      "Exempt this session from the idle-reaper — never auto-retired for " +
        "sitting idle. Default false. Toggle later with `session_set_keepalive`."
    ),
  options: jsonTolerant(
    z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
  )
    .optional()
    .describe(
      "Manifest-declared option id → value map (AIP-45 `options`), validated " +
        "against each option's declared type/enum/min/max. Unknown ids reject."
    ),
  skills: jsonTolerant(z.array(z.string()))
    .optional()
    .describe(
      "Skill ids for this session (e.g. ['agentproto']). REPLACES (not " +
        "unions) config defaults when set; adapters with no `skills` option " +
        `(e.g. claude-code) ignore it. ${help("skills")}`
    ),
  bundles: jsonTolerant(z.array(z.string()))
    .optional()
    .describe(
      "Capability bundle ids (`bundle_list`) — each expands to its imported " +
        "MCPs (mounted as native MCP servers, never via the mcp_imported_* " +
        "indirection) + skills, optionally the daemon's own /mcp. REPLACES " +
        `(not unions) config defaults when set. ${help("bundles")}`
    ),
  daemonMount: mcpBool
    .optional()
    .describe(
      "Mount the daemon's own scoped /mcp gateway for this spawn — the only " +
        "way for adapters outside the default self-mount set (opencode, " +
        `codex, gemini, …). Default false. ${help("daemonMount")}`
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model identifier to pass to the adapter. For claude-code, applied via " +
        "session/set_config_option — NOT a CLI flag."
    ),
  effort: z
    .string()
    .optional()
    .describe(
      "Reasoning effort label ('low'/'medium'/'high'/'xhigh'/'max'/'ultracode'), " +
        "calibrated PER MODEL — the same label means different compute budgets " +
        "across models. Omit for the model's default."
    ),
  route: jsonTolerant(
    z.object({ gateway: z.string().min(1), baseUrl: z.string().url().optional() })
  )
    .optional()
    .describe("Billing route/gateway. Independent of `model` and `access`."),
  inference: jsonTolerant(
    z.object({
      endpoint: z
        .string()
        .min(1)
        .optional()
        .describe('A registered local/LAN inference endpoint id (`agentproto llm endpoints list`), or "<id>@<device>" for a paired device\'s own shared endpoint.'),
      model: z
        .string()
        .min(1)
        .optional()
        .describe('A bare model id (paired with `endpoint`), or the shorthand "<model>@<device|endpoint>" when `endpoint` is omitted.'),
      force: mcpBool
        .optional()
        .describe("Skip the fit-check refusal on a clear miss (the check still runs and still warns)."),
      headroomPct: z
        .number()
        .min(0)
        .max(95)
        .optional()
        .describe("Headroom percentage held back from the endpoint's loaded ctx for the fit check. Default 25."),
    })
  )
    .optional()
    .describe(
      "Bind to a local/LAN inference endpoint instead of a cloud model: " +
        '`{endpoint}`, `{endpoint, model}`, or `{model: "<model>@<device|endpoint>"}`. ' +
        "Runs a PRE-SPAWN fit check (known first-request size vs the endpoint's " +
        "loaded ctx) and refuses with an actionable error on a clear miss " +
        "(`force` overrides). Mutually exclusive with `model`/`route`/`access`. " +
        `${help("inference")}`
    ),
  access: jsonTolerant(
    z.object({
      // When both are given, `profileRefs` wins and `profileRef` is ignored.
      profileRef: z.string().min(1).optional(),
      // Ordered candidates — the runtime bills the first eligible one. A
      // min(1) list; a named-but-missing profile anywhere is a hard error.
      profileRefs: z.array(z.string().min(1)).min(1).optional(),
    }),
  )
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
      // BOX-LOGIN BRIDGE — the HOST's forward-to-box marker: `true` means "the
      // redacted login copy for this file-based subscription was uploaded into
      // this box", which is the ONE thing that lets `resolveAuthSpec` skip its
      // missing-credential fail-fast. Set by the host's spawn/restart code only
      // after a successful write (see `box-login-bridge.ts`), never by a
      // client — hence a strict boolean, never a string/number.
      loginFile: z.boolean().optional(),
    // Passthrough: a host forwards sub-account scope (credentialEnv/extraEnv/
    // isolateDataHome) to its sandbox box; spawn-defaults validates those keys.
    }).passthrough()
  )
    .optional()
    .describe(
      "Billing-auth mode + credential for adapters that declare one " +
        "('subscription' default — bills the subscription login; 'api-key' " +
        "bills API credits; anything else fails with unsupported_auth_mode). " +
        `FAILS FAST, no fallback, if the resolved mode has no credential configured. ${help("auth")}`
    ),
  mcpServers: jsonTolerant(z.array(mcpServerMountEntrySchema))
    .optional()
    .describe(
      "MCP servers to mount into the spawned agent's session at spawn time. " +
        "Adapters that don't model MCP mounting ignore it."
    ),
  orchestrator: jsonTolerant(
    z.union([
      z.boolean(),
      z.object({
        tools: z
          .array(z.string())
          .optional()
          .describe("Explicit allowlist ⊆ the default subset — a child can never widen its own scope."),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("Max recursion depth reachable through this child (default 3, ceiling 8, lower-only on recursion)."),
        maxChildren: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Max concurrently-alive sub-agents this child may spawn (default 8, lower-only on recursion)."),
      }),
    ])
  )
    .optional()
    .describe(
      "Make this child a SCOPED orchestrator — mounts the daemon's own " +
        "spawn/supervise tools, limited to its own sub-agents (`true` = " +
        "default subset; `{ tools }` narrows it; a child can never widen " +
        `its own scope). Shell/fs/remote tools are NEVER exposed. ${help("orchestrator")}`
    ),
  notifyUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Per-session webhook URL, POSTed fire-and-forget on turn-end / " +
        "awaiting-input / exited, in addition to the global notify URL."
    ),
  notifySecret: z
    .string()
    .refine(s => decodeWhsecSecret(s) !== null, {
      message: "must be a whsec_<base64> Standard Webhooks secret (24-64 decoded bytes)",
    })
    .optional()
    .describe(`Standard Webhooks secret (\`whsec_...\`) signing \`notifyUrl\` POSTs. ${help("notifySecret")}`),
  wait: mcpBool
    .optional()
    .describe(
      "Block until the child's first turn completes (~40-90s+) and include " +
        "its output; default returns immediately. Batched `wait:true` calls " +
        `do NOT run in parallel — see \`tool_help {name:"agent_start", topic:"wait"}\`.`
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
      "Windowed cost-budget cap (DISTINCT from `maxCostUsd`) — trips " +
        "`policy:failed` on overage, never kills the session."
    ),
  restartPolicy: jsonTolerant(
    z.object({
      on: z
        .array(z.enum(["crashed", "error", "sandbox-gone"]))
        .min(1)
        .describe(
          "Death reasons that trigger a restart (`sandbox-gone`: box lost). " +
            "Never a clean exit, kill, idle-reap, or cost-budget kill.",
        ),
      maxRetries: z
        .number()
        .int()
        .positive()
        .describe("Rolling-window crash-loop cap: give up after this many restarts within `windowMs`."),
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
        .describe("Reserved for a future resume-vs-fresh-spawn toggle; this always revives in place today."),
    }),
  )
    .optional()
    .describe(
      "Opt-in auto-restart: an unexpected death (`crashed`/`error`, per " +
        "`on`) revives the session IN PLACE after exponential backoff, up " +
        `to a rolling-window crash-loop cap. Omit = today's stay-dead behaviour. ${help("restartPolicy")}`
    ),
  turnRetry: jsonTolerant(turnRetryInputSchema)
    .optional()
    .describe(
      `Opt-in: re-prompt after backoff when a turn fails transiently; "rotate" switches to another (non-cooling) model first. ${help("turnRetry")}`
    ),
  contextContinuity: jsonTolerant(contextContinuityInputSchema)
    .optional()
    .describe(
      "Context-continuity policy for this session: warn / opportunistic-compaction / " +
        "fresh-continuation / hard-stop thresholds. Resolved global → per-adapter → explicit."
    ),
  role: z
    .string()
    .optional()
    .describe(
      "Delegation gate: 'executor' = leaf, cannot delegate " +
        "(`agent_start`/`agent_prompt` stripped); 'supervisor' = may delegate " +
        " (default). Custom role packs resolve the same way; omit to derive " +
        `from spawn depth. ${help("role")}`
    ),
  promptAppend: z
    .string()
    .optional()
    .describe(
      "One-off runtime text layered onto the resolved role's disposition and " +
        "prepended to `prompt` — specializes it, cannot reopen a denied tool gate."
    ),
  deferredTools: z
    .boolean()
    .optional()
    .describe(
      "Override lazy MCP tool loading: `true` hides most tools from " +
        "`tools/list` (still callable via `tool_search`); `false` keeps the " +
        `full eager surface. Omit = harness/role/daemon default. ${help("deferredTools")}`
    ),
  browser: z
    .preprocess(
      // `true` is sugar for the only mode; stringified booleans tolerated.
      v => (v === true || v === "true" ? "headless" : v === "false" ? false : v),
      z.union([z.literal("headless"), z.literal(false)]),
    )
    .optional()
    .describe(
      "`\"headless\"` = isolated headless Chrome as a per-session `browser` " +
        `MCP server, torn down with the session. \`false\` (default) = none. Not supported with \`sandbox\`. ${help("browser")}`
    ),
  trace: z
    .boolean()
    .optional()
    .describe(
      "Emit Langfuse traces for this session (prompt/completion + tool spans " +
        "+ tokens/cost). Off by default; requires langfuse eval-reporter creds."
    ),
  sandbox: jsonTolerant(
    z.union([
      z
        .string()
        .min(1)
        .describe("Sandbox provider slug from `list_sandbox_providers` (e.g. 'local', 'e2b')."),
      sandboxSpecWithReuseSchema.describe(
        "Inline AIP-36 SandboxDefinition — boots this exact spec instead of a catalog slug. " +
          "Set `reuse` to reconnect to an existing sandbox instead of booting fresh."
      ),
    ])
  )
    .optional()
    .describe(
      "Run inside a sandbox box instead of on the host: a provider slug " +
        "(from `list_sandbox_providers`) or an inline AIP-36 spec (`reuse` " +
        "reconnects). The daemon boots the box, spawns `adapter` there, and " +
        "proxies the conversation back. DISTINCT from `commandSandbox` " +
        `(separate machine vs confining this host's own process). Omit = local. ${help("sandbox")}`
    ),
  sandboxCheckpoint: jsonTolerant(sandboxCheckpointOverrideSchema)
    .optional()
    .describe(`Per-spawn sandbox checkpoint override: false disables, or an object. ${help("sandboxCheckpoint")}`),
  cloud: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Managed cloud vendor slug (AIP-66, e.g. 'anthropic') — the VENDOR " +
        "owns the machine and the harness; the host relays via the vendor's " +
        "cloud adapter (e.g. 'claude-code-cloud'). DISTINCT from `sandbox`; " +
        "mutually exclusive with it and worktree/commandSandbox/mcpServers/" +
        `daemonMount/bundles/browser/appServe/inference. ${help("cloud")}`
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
          .describe("Port the UI binds inside the box (default 3210). Exposed by the sandbox provider as a public URL."),
      })
      .strict(),
  )
    .optional()
    .describe(
      "Serve an agentproto app's UI from INSIDE the sandbox box and return " +
        `its public URL. Requires \`sandbox\` (rejected otherwise). ${help("appServe")}`
    ),
  commandSandbox: commandSandboxSchema
    .optional()
    .describe(
      "OS-level confinement (Seatbelt/bubblewrap) of the adapter's OWN " +
        "process on THIS host — NOT `sandbox` (separate machine). `\"off\"` " +
        "(default) = unconfined; `\"workspace\"` = deny fs outside cwd; " +
        `\`\"strict\"\` = + deny network. Fails spawn if the OS backend is missing. ${help("commandSandbox")}`
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
            .describe("Pin the worktree's slug (branch `wt/<slug>`). Omit to auto-mint one from the label."),
          base: z
            .string()
            .min(1)
            .optional()
            .describe("Git ref the worktree branch is cut from. Default 'origin/main'."),
          async: z
            .boolean()
            .optional()
            .describe(
              "Return immediately (status \"starting\") instead of blocking on " +
                `provisioning; incompatible with \`wait\`. Defaults true. ${help("worktree")}`
            ),
        })
        .strict(),
    ])
  )
    .optional()
    .describe(
      "Isolate this session in its own git worktree (fresh `wt/<slug>` branch) " +
        "instead of `cwd`: `true` provisions one; `{ slug, base, async }` pins " +
        "details. ROOT spawns only (rejected on nested spawns — use `sandbox` " +
        "there); ignored when `cwd` isn't a git repo; NOT auto-removed on " +
        `close — tear down with \`agentproto worktree rm\`. ${help("worktree")}`
    ),
  // CONTROLLER-INTERNAL (issue #1647) — NOT for tool callers. The device
  // sandbox proxy (`bootSandboxAgentSession`, session-spawn.ts) stamps it
  // when it forwards an explicit `workspaceSlug` across the /device-spawn
  // bridge, so the TARGET daemon's `agent_start` treats the slug as
  // bridge-ffi: registry-first, no active-workspace fallback — an
  // unresolvable slug fails loudly (`device_bridge_workspace_unknown`)
  // instead of silently landing wherever the target happens to have active.
  deviceBridge: mcpBool
    .optional()
    .describe(
      "Internal: set by the controller's device-sandbox bridge; do not set. " +
        `See tool_help topic \`deviceBridge\`.`
    ),
  // CONTROLLER-INTERNAL — not a tool-caller surface. The host daemon's box
  // re-attach path (`session_restart` on a session whose sandbox box is
  // still alive) hands the BOX daemon the prior in-box session id so the
  // box continues that adapter conversation instead of starting blank; the
  // HTTP `POST /sessions` route passes a raw adapter conversation id. The
  // box resolves a session id on ITS OWN registry to that row's adapter
  // conversation + isolated config dir (the same ACP-level resume a local
  // restart uses) and reports the outcome on the descriptor's `resumeVia`.
  resumeSessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Internal: reattach to a prior adapter conversation (session id or raw " +
        "adapter conversation id). Set by a host re-attaching its sandbox box; " +
        "not for tool callers. See tool_help topic `resumeSessionId`."
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
