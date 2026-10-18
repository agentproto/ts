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
import { opaqueSchema } from "./tool-schema-opaque.js"

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

/** Opaque nested field (real validation kept) — see tool-schema-opaque.ts. */
const opaque = <T extends z.ZodTypeAny>(real: T, field: string) =>
  opaqueSchema(real, { tool: "agent_start", field })

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
      `Adapter slug (e.g. 'claude-code', 'hermes'); omit when \`presetId\` supplies one.`
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
      "Saved spawn preset id (`agentproto preset list`); explicit fields on this call override it."
    ),
  workspaceSlug: z
    .string()
    .optional()
    .describe(
      "Workspace slug (`agentproto workspace list`) resolved to a path; with `sandbox` its remote is cloned into the box."
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      `Absolute path to spawn in; wins over \`workspaceSlug\`.`
    ),
  prompt: opaque(promptInputSchema, "prompt")
    .optional()
    .describe(
      `Optional initial prompt — spawns and dispatches it in one call. Plain string or content-block array. ${help("prompt")}`
    ),
  label: z
    .string()
    .optional()
    .describe("Free-text label shown in `agent_sessions_list` and the UI."),
  mode: z
    .string()
    .optional()
    .describe(
      `Manifest-declared mode id (AIP-45); adapters without \`modes\` reject any value.`
    ),
  origin: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Source label for this spawn (codex, cowork, vscode, cron, …) — descriptor-only."
    ),
  parentSessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Parent-lineage hint: nest this spawn under that session; ignored through the scoped gateway.`
    ),
  attach: jsonTolerant(opaque(attachFieldSchema, "attach"))
    .optional()
    .describe(
      `Parent-attach override, mirrors \`worktree\`. \`false\` = independent root. ${help("attach")}`
    ),
  boardId: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Task-board pin for the child (\`meta.boardId\`), resolved before parent-lineage.`
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Retried call with the SAME key+adapter+cwd within ~10min returns the SAME session.`
    ),
  dedupe: mcpBool
    .optional()
    .describe(
      `Override implicit dedup-by-\`label\`: \`false\` opts out, \`true\` forces it.`
    ),
  permissionHold: mcpBool
    .optional()
    .describe(
      "Hold ACP permission requests in the cross-session inbox instead of auto-answering. ACP only."
    ),
  notifyParentOnCrash: mcpBool
    .optional()
    .describe(
      `Notify this session's parent in-band if it later crashes. Default false.`
    ),
  sentinel: mcpBool
    .optional()
    .describe(
      `Set false to opt this spawn out of sentinel auto-link.`
    ),
  allowSharedCwd: mcpBool
    .optional()
    .describe(
      "Acknowledge running a nested spawn in the parent's dirty working tree; silences the warning. Default false."
    ),
  keepAlive: mcpBool
    .optional()
    .describe(
      "Exempt this session from the idle-reaper. Default false; toggle later with `session_set_keepalive`."
    ),
  options: jsonTolerant(
    opaque(
      z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
      "options"
    )
  )
    .optional()
    .describe(
      `Manifest-declared option id → value map (AIP-45); validated against each option's declared type. ${help("options")}`
    ),
  skills: jsonTolerant(z.array(z.string()))
    .optional()
    .describe(
      `Normalized skill ids (e.g. ['agentproto']). REPLACES config defaults when set. ${help("skills")}`
    ),
  bundles: jsonTolerant(z.array(z.string()))
    .optional()
    .describe(
      `Capability bundle ids (\`bundle_list\`) to attach. REPLACES config defaults when set. ${help("bundles")}`
    ),
  daemonMount: mcpBool
    .optional()
    .describe(
      `Explicitly mount the daemon's own scoped /mcp gateway for this spawn. Default false.`
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model identifier for the adapter. claude-code applies it via session/set_config_option, not a CLI flag."
    ),
  effort: z
    .string()
    .optional()
    .describe(
      "Reasoning effort label ('low'/'medium'/'high'/'xhigh'/'max'/'ultracode'), calibrated PER MODEL. Omit for the model default."
    ),
  route: jsonTolerant(
    opaque(
      z.object({ gateway: z.string().min(1), baseUrl: z.string().url().optional() }),
      "route"
    )
  )
    .optional()
    .describe("Billing route/gateway. Independent of `model` and `access`."),
  inference: jsonTolerant(
    opaque(
      z.object({
        endpoint: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        force: mcpBool.optional(),
        headroomPct: z.number().min(0).max(95).optional(),
      }),
      "inference"
    )
  )
    .optional()
    .describe(
      `Bind to a local/LAN inference endpoint instead of a cloud model; fit-checked before spawning. ${help("inference")}`
    ),
  access: jsonTolerant(
    opaque(
      z.object({
        profileRef: z.string().min(1).optional(),
        profileRefs: z.array(z.string().min(1)).min(1).optional(),
      }),
      "access"
    )
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
    opaque(
      z.object({
        mode: z.enum(["subscription", "api-key"]).optional(),
        token: z.string().optional(),
        source: z.string().optional(),
        apiKey: z.string().optional(),
        loginFile: z.boolean().optional(),
      }).passthrough(),
      "auth"
    )
  )
    .optional()
    .describe(
      `Explicit billing-auth mode + credential; FAILS FAST when the resolved mode has no credential. ${help("auth")}`
    ),
  mcpServers: jsonTolerant(opaque(z.array(mcpServerMountEntrySchema), "mcpServers"))
    .optional()
    .describe(
      "MCP servers to mount into the spawned agent's session at spawn time; adapters without MCP mounting ignore it."
    ),
  orchestrator: jsonTolerant(
    opaque(
      z.union([
        z.boolean(),
        z.object({
          tools: z.array(z.string()).optional(),
          maxDepth: z.number().int().min(1).max(8).optional(),
          maxChildren: z.number().int().min(1).optional(),
        }),
      ]),
      "orchestrator"
    )
  )
    .optional()
    .describe(
      `Make this child a SCOPED orchestrator — auto-mounts the daemon's spawn/supervise tools. ${help("orchestrator")}`
    ),
  notifyUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Optional per-session webhook URL, POSTed on turn-end / awaiting-input / exited events."
    ),
  notifySecret: z
    .string()
    .refine(s => decodeWhsecSecret(s) !== null, {
      message: "must be a whsec_<base64> Standard Webhooks secret (24-64 decoded bytes)",
    })
    .optional()
    .describe(`Standard Webhooks secret (\`whsec_...\`) signing \`notifyUrl\` POSTs.`),
  wait: mcpBool
    .optional()
    .describe(
      `Block until the first turn completes (~40-90s+) and include its output. Default false.`
    ),
  maxCostUsd: mcpPositiveNumber
    .optional()
    .describe(
      "Hard ceiling on cumulative session cost (USD); stopped at a turn-end once exceeded."
    ),
  costBudget: jsonTolerant(
    opaque(
      z.object({
        maxCostUsd: z.number().positive(),
        window: z.string().min(1),
        scope: z.enum(["session", "profile"]),
      }),
      "costBudget"
    )
  )
    .optional()
    .describe(
      `Windowed cost-budget cap (DISTINCT from \`maxCostUsd\`); trips \`policy:failed\`, never kills. ${help("costBudget")}`
    ),
  restartPolicy: jsonTolerant(
    opaque(
      z.object({
        on: z.array(z.enum(["crashed", "error", "sandbox-gone"])).min(1),
        maxRetries: z.number().int().positive(),
        windowMs: z.number().int().positive(),
        baseDelayMs: z.number().int().positive(),
        factor: z.number().positive(),
        maxDelayMs: z.number().int().positive(),
        resume: z.boolean().optional(),
      }),
      "restartPolicy"
    )
  )
    .optional()
    .describe(
      `Opt-in auto-restart of an unexpected death in place after backoff. Omit to stay dead. ${help("restartPolicy")}`
    ),
  turnRetry: jsonTolerant(turnRetryInputSchema)
    .optional()
    .describe(
      `Opt-in: re-prompt after backoff when a turn fails transiently; "rotate" switches to another (non-cooling) model first. ${help("turnRetry")}`
    ),
  contextContinuity: jsonTolerant(
    opaque(contextContinuityInputSchema, "contextContinuity")
  )
    .optional()
    .describe(
      `Context-continuity policy: warning, compaction, fresh-continuation and hard-stop thresholds. ${help("contextContinuity")}`
    ),
  role: z
    .string()
    .optional()
    .describe(
      `Delegation gate: 'executor' = leaf (cannot delegate), 'supervisor' = may delegate. ${help("role")}`
    ),
  promptAppend: z
    .string()
    .optional()
    .describe(
      "One-off runtime text layered onto the resolved role's disposition and prepended to `prompt`."
    ),
  deferredTools: z
    .boolean()
    .optional()
    .describe(
      `Override lazy MCP tool loading: \`true\` hides most tools from tools/list. ${help("deferredTools")}`
    ),
  browser: opaque(
    z.preprocess(
      // `true` is sugar for the only mode; stringified booleans tolerated.
      v => (v === true || v === "true" ? "headless" : v === "false" ? false : v),
      z.union([z.literal("headless"), z.literal(false)]),
    ),
    "browser"
  )
    .optional()
    .describe(
      `\`"headless"\` gives the session its own isolated headless Chrome; \`false\` = none (default). ${help("browser")}`
    ),
  trace: z
    .boolean()
    .optional()
    .describe(
      "Emit Langfuse observability traces for this session. Off by default; needs langfuse creds."
    ),
  sandbox: jsonTolerant(
    opaque(
      z.union([z.string().min(1), sandboxSpecWithReuseSchema]),
      "sandbox"
    )
  )
    .optional()
    .describe(
      `Run in a sandbox box (provider slug or inline AIP-36 spec) instead of the host. DISTINCT from \`commandSandbox\`. ${help("sandbox")}`
    ),
  sandboxCheckpoint: jsonTolerant(sandboxCheckpointOverrideSchema)
    .optional()
    .describe(`Per-spawn sandbox checkpoint override: false disables, or an object. ${help("sandboxCheckpoint")}`),
  cloud: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Managed cloud vendor slug (AIP-66, e.g. 'anthropic'); the VENDOR owns the machine. ${help("cloud")}`
    ),
  appServe: jsonTolerant(
    opaque(
      z
        .object({
          dir: z.string().min(1),
          port: z.number().int().min(1).max(65535).optional(),
        })
        .strict(),
      "appServe"
    )
  )
    .optional()
    .describe(
      `Serve an agentproto app's UI from INSIDE the sandbox box. Requires \`sandbox\`. ${help("appServe")}`
    ),
  commandSandbox: commandSandboxSchema
    .optional()
    .describe(
      `OS-level confinement of the adapter's OWN process on THIS host; NOT \`sandbox\`.`
    ),
  worktree: jsonTolerant(
    opaque(
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
              .optional(),
            base: z.string().min(1).optional(),
            async: z.boolean().optional(),
          })
          .strict(),
      ]),
      "worktree"
    )
  )
    .optional()
    .describe(
      `Isolate this session in its own git worktree instead of \`cwd\`; ROOT spawns only. ${help("worktree")}`
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
      "Internal: set by the controller's device-sandbox bridge when this spawn crossed a device pairing. Do not set."
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
      "Internal: reattach to a prior adapter conversation. Not for tool callers."
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
