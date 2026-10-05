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
import { sandboxSpecWithReuseSchema } from "./sandbox-spec-schema.js"
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
      "Workspace slug from `agentproto workspace list`, resolved to a path. " +
        "Omit to use `cwd` or the active workspace."
    ),
  cwd: z
    .string()
    .optional()
    .describe("Absolute path to spawn the agent in. Wins over `workspaceSlug` when both are set."),
  prompt: promptInputSchema
    .optional()
    .describe(
      "Optional initial prompt — spawns and dispatches it in one call " +
        "(spawn + `agent_prompt` combined). Omit to spawn idle. A plain " +
        "string is composed with the role/AGENTS.md disposition preamble " +
        "as usual; a content block or block array (e.g. a pasted image, " +
        "`{type:\"image\", data, mimeType}`) SKIPS that composition and is " +
        "sent to the adapter verbatim — the adapter negotiates its own " +
        "multimodal support. " +
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
        "starts (e.g. claude-code's 'plan'/'accept-edits'/'bypass-permissions'). " +
        `Adapters with no declared \`modes\` REJECT any value here. ${help("mode")}`
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
        "instead of a depth-0 root. Ignored through the scoped orchestrator " +
        `gateway (its own token wins). ${help("parentSessionId")}`
    ),
  attach: jsonTolerant(attachFieldSchema)
    .optional()
    .describe(
      "Parent-attach override, mirrors `worktree`. Default attaches under the " +
        "calling session; `false` = independent root; `true` forces attach; " +
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
      "Caller-declared dedup token: a retried call with the SAME key for the " +
        "same `adapter`+`cwd` within ~10min of a successful spawn returns that " +
        "SAME session (`deduped: true`) instead of forking a new one. Always " +
        `wins over the implicit key \`dedupe\` derives. ${help("idempotencyKey")}`
    ),
  dedupe: mcpBool
    .optional()
    .describe(
      "Override the implicit dedup-by-`label` default (on when no " +
        "`idempotencyKey` is given): `false` opts this spawn out, `true` " +
        `forces it even under an "on-request" daemon policy. ${help("dedupe")}`
    ),
  permissionHold: mcpBool
    .optional()
    .describe(
      "Hold every ACP permission request in the cross-session inbox " +
        "(`permissions_list`/`permissions_respond`) instead of auto-answering. " +
        "ACP adapters only; default false."
    ),
  notifyParentOnCrash: mcpBool
    .optional()
    .describe(
      "Notify this session's parent directly (in-band) if it later crashes. " +
        `Independent of the global \`notifyUrl\` webhook, which fires either way. ${help("notifyParentOnCrash")}`
    ),
  sentinel: mcpBool
    .optional()
    .describe(
      "Set false to opt this spawn OUT of sentinel auto-link: a PR this " +
        "session opens will never get an automatic AIP-60 sentinel watching " +
        `it, regardless of the daemon's \`sentinel.autoWatchPrs\` config. ${help("sentinel")}`
    ),
  allowSharedCwd: mcpBool
    .optional()
    .describe(
      "Acknowledge running a nested spawn in the parent's dirty working tree, " +
        "silencing the shared-dirty-cwd warning. Only relevant with no " +
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
      "Normalized skill ids for this session (e.g. ['agentproto']). REPLACES " +
        "(not unions) config defaults when set. Adapters with no `skills` " +
        `option (e.g. claude-code) ignore it. ${help("skills")}`
    ),
  bundles: jsonTolerant(z.array(z.string()))
    .optional()
    .describe(
      "Capability bundle ids (`bundle_list`) to attach — each expands to its " +
        "imported MCPs (mounted as native MCP servers, never via the " +
        "mcp_imported_* indirection) + skills, and optionally the daemon's " +
        "own /mcp. REPLACES (not unions) config defaults when set. " +
        `${help("bundles")}`
    ),
  daemonMount: mcpBool
    .optional()
    .describe(
      "Explicitly mount the daemon's own scoped /mcp gateway for this spawn " +
        "— the only way an adapter outside the default self-mount set " +
        `(opencode, codex, gemini, …) gets it. Default false. ${help("daemonMount")}`
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
      "Reasoning effort label ('low'/'medium'/'high'/'xhigh'/'max'/'ultracode'). " +
        "Calibrated PER MODEL — the same label means different compute budgets " +
        "across models. Omit to keep the model's own default."
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
      "Bind this spawn to a local/LAN inference endpoint instead of a cloud model: `{endpoint}`, " +
        '`{endpoint, model}`, or the shorthand `{model: "<model>@<device|endpoint>"}`. Runs a fit ' +
        "check (the harness's known first-request size vs the endpoint's loaded ctx) BEFORE " +
        "spawning and refuses with an actionable error on a clear miss (`force` overrides). " +
        'Defaults `adapter`/`harness` to "pi" when neither is set. Mutually exclusive with ' +
        `\`model\`/\`route\`/\`access\` — set those directly instead of \`inference\`, never both. ${help("inference")}`
    ),
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
      "Explicit billing-auth mode + credential for adapters that declare it " +
        "(those that declare a subscription login and/or an API-key provider; " +
        "any other fails with unsupported_auth_mode) — 'subscription' " +
        "(default) bills the user's subscription login, 'api-key' bills API " +
        "credits. FAILS FAST with no fallback if the " +
        `resolved mode has no credential configured anywhere. ${help("auth")}`
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
          .describe("Static HTTP headers for `http`/`sse` transports. Ignored for `stdio`."),
        credentialRef: z
          .string()
          .optional()
          .describe(
            "Brokered credential resolved into `headers` at spawn time (wins on " +
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
    )
  )
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
      "Make this child a SCOPED orchestrator — auto-mounts the daemon's own " +
        "spawn/supervise tools, scoped to its own sub-agents. `true` = default " +
        `subset; \`{ tools }\` narrows it. Shell/fs/remote tools are NEVER exposed. ${help("orchestrator")}`
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
      "Block until the spawned session's first turn completes (~40-90s+) and " +
        "include its output. Default false = return immediately. Batched " +
        "`wait:true` calls do NOT run in parallel — see " +
        `\`tool_help {name:"agent_start", topic:"wait"}\` for the fan-out pattern.`
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
        .array(z.enum(["crashed", "error"]))
        .min(1)
        .describe("Which automatic death reasons trigger a restart. Never a clean exit, kill, idle-reap, or cost-budget kill."),
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
      "Opt-in auto-restart policy: an unexpected death (`crashed`/`error`, per " +
        "`on`) is revived IN PLACE after exponential backoff, up to a " +
        `rolling-window crash-loop cap. Omit for today's stay-dead behaviour. ${help("restartPolicy")}`
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
      "Spawn-time delegation gate. 'executor' = leaf, cannot delegate " +
        "(`agent_start`/`agent_prompt` stripped). 'supervisor' = may delegate " +
        "(default). Custom role packs resolve the same way. Omit to derive " +
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
      "Override lazy MCP tool loading for this spawn: `true` hides most " +
        "tools from `tools/list` (still callable via `tool_search`), `false` " +
        `keeps the full eager surface. Omit to use the harness/role/daemon default ` +
        `(harnesses with native tool search default to eager). ${help("deferredTools")}`
    ),
  browser: z
    .preprocess(
      // `true` is sugar for the only mode; stringified booleans tolerated.
      v => (v === true || v === "true" ? "headless" : v === "false" ? false : v),
      z.union([z.literal("headless"), z.literal(false)]),
    )
    .optional()
    .describe(
      "`\"headless\"` gives the spawned agent its own isolated headless " +
        "Chrome as a per-session `browser` MCP server, torn down with the " +
        `session. \`false\` = none (default). Not supported with \`sandbox\`. ${help("browser")}`
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
          "Set `reuse` to reconnect to an existing sandbox instead of booting fresh."
      ),
    ])
  )
    .optional()
    .describe(
      "Run this session inside a sandbox instead of on the host (provider " +
        "slug or inline AIP-36 spec) — the daemon boots the box, spawns " +
        "`adapter` on its own agentproto daemon, and proxies the conversation " +
        "back here. DISTINCT from `commandSandbox` (whole separate machine vs. " +
        `confining this host's own process). Omit to run locally. ${help("sandbox")}`
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
      "OS-level confinement (macOS Seatbelt / Linux bubblewrap) of the " +
        "adapter's OWN process on THIS host — NOT `sandbox` above, which boots " +
        "a separate machine. `\"off\"` (default) = unconfined; `\"workspace\"` " +
        "= deny reads/writes outside cwd; `\"strict\"` = + deny network. Fails " +
        `the spawn if the OS backend isn't installed. ${help("commandSandbox")}`
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
              "Return a registered session immediately (status \"starting\") " +
                "instead of blocking on provisioning; incompatible with `wait`. " +
                `Defaults true whenever a worktree is provisioned. ${help("worktree")}`
            ),
        })
        .strict(),
    ])
  )
    .optional()
    .describe(
      "Isolate this session in its OWN git worktree instead of `cwd`. `true` " +
        "provisions one on a fresh `wt/<slug>` branch; `{ slug, base, async }` " +
        "pins details. ROOT spawns only (rejected on a nested spawn — use " +
        "`sandbox` there); ignored when `cwd` isn't a git repo. NOT " +
        `auto-removed on session close — tear down with \`agentproto worktree rm\`. ${help("worktree")}`
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
      "Internal: set by the controller's device-sandbox bridge when this " +
        "spawn crossed a device pairing. Do not set — an explicit " +
        "`workspaceSlug` that the target daemon has not registered fails " +
        "instead of falling back to its active workspace."
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
