/**
 * AIP-45 AGENT-CLI.md frontmatter zod schema.
 *
 * Mirrors `resources/aip-45/draft/AGENT-CLI.schema.json`. AIP-45 is a
 * sibling of AIP-29 (CLI.md, tool CLIs) covering interactive
 * agent-as-process binaries. The `protocol` discriminator (acp / mcp
 * / proprietary) selects the wire arm; cross-field rules ensure the
 * matching arm-specific block is present.
 *
 * Both authoring paths (`define-agent-cli.ts` and
 * `manifest/index.ts`) validate against this schema, so every
 * field-level constraint runs in both paths from a single source of
 * truth.
 */

import { z } from "zod"

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SEMVER_RANGE_PATTERN = /^[><=^~ \d.\-+\w*xX|, ]+$/
const ADAPTER_PATTERN = /^@?[a-z0-9][a-z0-9-./]*$/
const BIN_PATTERN = /^[A-Za-z0-9._\-/]+$/
const MODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const OPTION_ID_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/

const CONTINUATION_STRATEGY_IDS = [
  "none",
  "pinned-session",
  "transcript",
  "native-resume",
] as const

const CONTINUATION_KEY_SCOPES = [
  "conversation",
  "operator",
  "user",
  "guild",
  "workspace",
] as const

// AIP-29 install methods, mirrored locally to avoid a runtime cross-package import.
// Schema-level $ref to AIP-29 is preserved on the JSON Schema side
// (resources/aip-45/draft/AGENT-CLI.schema.json); this zod copy is the
// TS-side mirror used by `defineAgentCli`. When AIP-29 grows new
// install methods, both sides update together via scaffold-aip.

const installMethodSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("brew"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("apt"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("dnf"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("pacman"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("choco"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("scoop"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("npm"), package: z.string(), global: z.boolean().optional(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("pip"), package: z.string(), user: z.boolean().optional(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("cargo"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("go"), package: z.string(), experimental: z.boolean().optional() }).strict(),
  z.object({
    method: z.literal("curl"),
    url: z.string().url(),
    verify_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    experimental: z.boolean().optional(),
  }).strict(),
  z.object({
    method: z.literal("download"),
    url: z.string().url(),
    extract_bin: z.string(),
    verify_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    experimental: z.boolean().optional(),
  }).strict(),
  z.object({ method: z.literal("vendored"), path: z.string(), experimental: z.boolean().optional() }).strict(),
])

const versionCheckSchema = z.object({
  cmd: z.string(),
  parse: z.string().describe("ECMAScript regex with at least one capture group."),
  range: z.string().regex(SEMVER_RANGE_PATTERN).describe("npm-style semver range."),
  timeout_ms: z.number().int().min(100).default(5000),
}).strict()

const SETUP_STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SECRET_SLUG_PATTERN = /^([a-z][a-z0-9-]*[a-z0-9]\/)?[a-z][a-z0-9-]*[a-z0-9]$/

// `skip_if`: re-runnable health check that, when matching, skips the
// enclosing setup step. Lets `agentproto setup <slug>` re-runs be
// idempotent without external completion-ledger state.
const skipIfSchema = z
  .object({
    cmd: z.string(),
    exit_code: z.number().int().default(0),
    timeout_ms: z.number().int().min(100).default(5_000),
  })
  .strict()

// `persist`: where the captured value lands so the runner can reuse
// it on every spawn. Exactly one of env / secret_slug / cmd, enforced
// via discriminated union.
const persistEnvSchema = z
  .object({ env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) })
  .strict()
const persistSecretSchema = z
  .object({ secret_slug: z.string().regex(SECRET_SLUG_PATTERN).min(2).max(80) })
  .strict()
const persistCmdSchema = z.object({ cmd: z.string() }).strict()
const setupPersistSchema = z.union([
  persistEnvSchema,
  persistSecretSchema,
  persistCmdSchema,
])

// AIP-29 § Setup. Mirrors `resources/aip-29/draft/CLI.schema.json#/$defs/setupStep`.
// The runner runs steps in declared order, persists completion per
// (bundle.id, workspace.id, user.id), and surfaces `setup_required`
// to headless callers when steps remain pending.
const setupStepSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().regex(SETUP_STEP_ID_PATTERN),
      kind: z.literal("cmd"),
      cmd: z.string(),
      description: z.string().max(2000).optional(),
      skip_if: skipIfSchema.optional(),
      timeout_ms: z.number().int().min(100).default(60_000),
      interactive: z.boolean().default(false),
      persist: setupPersistSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(SETUP_STEP_ID_PATTERN),
      kind: z.literal("prompt"),
      prompt: z.string().min(1),
      description: z.string().max(2000).optional(),
      type: z.enum(["text", "select", "boolean", "secret"]).default("text"),
      default: z.string().optional(),
      options: z
        .union([
          z.array(z.string().min(1)).min(1),
          z
            .object({
              cmd: z.string(),
              timeout_ms: z.number().int().min(100).default(30_000),
            })
            .strict(),
        ])
        .optional(),
      skip_if: skipIfSchema.optional(),
      persist: setupPersistSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(SETUP_STEP_ID_PATTERN),
      kind: z.literal("oauth"),
      secret_slug: z.string().regex(SECRET_SLUG_PATTERN).min(2).max(80),
      description: z.string().max(2000).optional(),
      skip_if: skipIfSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(SETUP_STEP_ID_PATTERN),
      kind: z.literal("external"),
      url: z.string().url(),
      description: z.string().max(2000).optional(),
      callback: z
        .object({
          param: z.string().min(1).optional(),
          timeout_ms: z.number().int().min(1_000).default(600_000),
        })
        .strict()
        .optional(),
      skip_if: skipIfSchema.optional(),
      persist: setupPersistSchema.optional(),
    })
    .strict(),
])

const authSchema = z.object({
  ref: z.string().optional(),
  state: z.object({
    paths: z.array(z.string()).optional(),
    env: z.array(z.string()).optional(),
  }).strict().optional(),
  login: z.object({
    cmd: z.string(),
    interactive: z.boolean().optional(),
    requires_callback_url: z.boolean().optional(),
  }).strict().optional(),
  refresh: z.object({
    cmd: z.string(),
    interval_s: z.number().int().positive().optional(),
  }).strict().optional(),
  expiry: z.object({
    parse: z.string().optional(),
    grace_s: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict()

// Subscription (OAuth/bearer) billing declaration — see
// AgentCliAuthSubscription. Presence = "supports subscription mode". Two
// shapes:
//   - bearer-injection (claude-code): `setEnv` is the var the runtime SETS to
//     the resolved OAuth bearer.
//   - external / file-based (codex, gemini): `external: true` and NO `setEnv` —
//     the CLI reads its own local-login file (`~/.codex/auth.json`, …), so the
//     runtime injects NOTHING and only scrubs the conflicting api-key vars.
// `conflictEnv` are sibling credential vars scrubbed in every mode (except when
// set); `unsetEnvAdd` is native-mode-only gateway hygiene.
const authSubscriptionEntrySchema = z.object({
  setEnv: z.string().min(1).optional(),
  external: z.boolean().optional(),
  conflictEnv: z.array(z.string()).optional(),
  unsetEnvAdd: z.array(z.string()).optional(),
  // Provider scope for a multi-provider adapter's bearer surface (pi's
  // ANTHROPIC_OAUTH_TOKEN is anthropic-only) — see AgentCliAuthSubscription.
  provider: z.string().min(1).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.external) {
    if (v.setEnv !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "authSubscription.external: true must NOT declare setEnv — an external " +
          "(file-based) subscription injects no bearer; the CLI reads its own login file.",
        path: ["setEnv"],
      })
    }
  } else if (v.setEnv === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "authSubscription requires setEnv unless external: true (the bearer must be " +
        "injected into some env var).",
      path: ["setEnv"],
    })
  }
})

// `authSubscription` accepts either ONE surface (today's shape, unscoped or
// provider-scoped) or an ARRAY of surfaces — a multi-provider adapter that
// ships more than one native OAuth login (mastracode: Claude AND ChatGPT)
// declares one entry per provider. Two entries claiming the SAME provider
// scope (or two unscoped entries) are ambiguous — the runtime's
// `subscriptionSurfaceFor` has no tiebreak rule, so this is rejected at
// validation time rather than resolved arbitrarily at spawn time.
const authSubscriptionSchema = z
  .union([authSubscriptionEntrySchema, z.array(authSubscriptionEntrySchema).min(1)])
  .superRefine((v, ctx) => {
    if (!Array.isArray(v)) return
    const seen = new Set<string>()
    for (const entry of v) {
      const key = entry.provider ?? "\0unscoped"
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: entry.provider
            ? `authSubscription: duplicate provider scope "${entry.provider}" — two ` +
              `entries claim the same provider, which is ambiguous at spawn time.`
            : "authSubscription: more than one unscoped entry (no `provider`) — " +
              "ambiguous which one applies at spawn time.",
        })
      }
      seen.add(key)
    }
  })

const sessionSchema = z.object({
  mode: z.enum(["ephemeral", "persistent", "resumable"]).default("ephemeral"),
  idle_timeout_ms: z.number().int().min(1000).default(600_000),
  // No default: undefined disables the per-turn watchdog entirely. Only
  // adapters known to sometimes drop the final `prompt` response (e.g.
  // hermes) should declare this — applying it broadly would risk
  // false-positiving on another adapter's legitimately long turns.
  turn_idle_timeout_ms: z.number().int().min(1000).optional(),
  max_turns: z.number().int().positive().optional(),
  context_carryover: z.boolean().default(true),
}).strict()

// A `models.allowed` entry: a bare id (provider unstated, adapter default)
// or a { id, provider?, mode? } binding stating who serves it and which
// adapter mode reaches it. See AgentCliModelEntry (types.ts).
const modelEntrySchema = z.union([
  z.string(),
  z.object({
    id: z.string(),
    provider: z.string().optional(),
    mode: z.string().optional(),
  }).strict(),
])

const modelsSchema = z.object({
  default: z.string().optional(),
  allowed: z.array(modelEntrySchema).optional(),
  // Model-id patterns the adapter must never route to (case-insensitive,
  // trailing `*` = prefix match). Enforced at compose time — see
  // AgentCliModels.deny. Reserves premium providers for dedicated adapters.
  deny: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // How a model is selected at session start: "config" (ACP
  // set_config_option, default) | "command" (a `/model <id>` control turn,
  // for agents like hermes that ignore the ACP session model config) |
  // "arg" (a CLI argument composed into bin_args at spawn).
  apply: z.enum(["config", "command", "arg"]).optional(),
  // Argv template for apply:"arg" — {model} interpolates the requested
  // model id. See AgentCliModels.bin_args_template.
  bin_args_template: z.array(z.string()).optional(),
}).strict()

const capabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  tool_calls: z.boolean().optional(),
  sub_agents: z.boolean().optional(),
  file_io: z.boolean().optional(),
  multimodal: z.boolean().optional(),
  resumable: z.boolean().optional(),
  bidirectional: z.boolean().optional(),
  /**
   * Adapter has a verified native CLI resume into a real terminal/TUI
   * session (e.g. `claude --resume <id>` or `hermes --resume <id> --tui`).
   * When true, the host MAY restart this adapter via its native resume argv
   * as a PTY session. Distinct from ACP-level `resumable`.
   */
  nativeTerminalResume: z.boolean().optional(),
  /**
   * Adapter can ingest a filesystem path that the host UI just placed
   * on disk (host-side drag-drop into a terminal pastes the path
   * here). Implies the adapter has a Read-file tool wired so the
   * dropped path actually does something. Hosts gate drag-drop UI on
   * this flag — defaults to false (conservative).
   */
  file_attach: z.boolean().optional(),
}).strict()

export const modeSchema = z.object({
  id: z.string().regex(MODE_ID_PATTERN),
  description: z.string().optional(),
  // Which orthogonal session-config axis this mode expresses (SPEC-tracked in
  // @agentproto/runtime's session-config.ts). Narrowed to only "context" (SPEC
  // §3.4a): route is derived from the model catalog (@route), not a manifest
  // mode, and posture comes from the harness's own ACP mode registry
  // (SessionModeState.availableModes) — neither is a `modes[]` entry anymore.
  // The legacy "posture"/"route" classification still exists, but only inside
  // the daemon's back-compat `decomposeMode` shim, not this manifest surface.
  kind: z.enum(["context"]).optional(),
  bin_args_prepend: z.array(z.string()).optional(),
  bin_args_append: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Env keys to DELETE from the spawn env (auth hygiene for gateway
  // modes — see AgentCliMode.env_unset). Applied at the runtime merge
  // point, not as a static set.
  env_unset: z.array(z.string()).optional(),
  // Honest support status surfaced to clients. Absent ⇒ "active".
  status: z.enum(["active", "noop", "planned"]).optional(),
  status_note: z.string().optional(),
  // How the host activates this mode: "bin_args" (default, argv/env
  // composed at spawn) | "config" (no CLI surface — forwarded to the ACP
  // arm's connect({mode}) and applied via session/set_config_option
  // configId:"mode", e.g. opencode).
  apply: z.enum(["bin_args", "config"]).optional(),
}).strict()

const optionSchema = z.object({
  id: z.string().regex(OPTION_ID_PATTERN),
  type: z.enum(["boolean", "integer", "string", "enum"]),
  description: z.string().optional(),
  enum: z.array(z.string()).min(1).optional(),
  default: z.union([z.boolean(), z.number(), z.string()]).optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  bin_args_prepend: z.array(z.string()).optional(),
  bin_args_template: z.array(z.string()).optional(),
  bin_args_append_when_true: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Env keys to DELETE from the spawn env when this option is active
  // (auth hygiene for value-bearing gateway options — see
  // AgentCliOption.env_unset). Symmetric with modeSchema.env_unset.
  env_unset: z.array(z.string()).optional(),
}).strict().refine(
  // type === "enum" REQUIRES an `enum` array. The JSON Schema enforces
  // this via `if/then`; the zod side mirrors with a refine so both
  // validation paths reject the same shapes.
  o => o.type !== "enum" || (Array.isArray(o.enum) && o.enum.length > 0),
  { message: "option.type === 'enum' requires a non-empty `enum` array" }
)

// AIP-45 gateway-preset declaration (see AgentCliPresetDeclaration). A
// backend an Anthropic/OpenAI-compatible adapter can front, declared in
// the manifest so the catalog can surface adapter-contributed presets
// alongside the built-in registry. `scrubEnv` is optional here — an
// adapter that scrubs in code may omit it.
const presetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  schemaFlavor: z.enum(["anthropic", "openai"]),
  baseUrl: z.string().min(1),
  keyEnv: z.string().min(1),
  scrubEnv: z.array(z.string()).optional(),
  defaultModel: z.string().optional(),
  homepage: z.string().optional(),
}).strict()


const continuationStrategyIdSchema = z.enum(CONTINUATION_STRATEGY_IDS)

const continuationSchema = z.object({
  default: continuationStrategyIdSchema,
  supported: z.array(continuationStrategyIdSchema).min(1),
  pinned_session: z.object({
    idle_timeout_ms: z.number().int().min(1000).default(1_800_000),
    key_scope: z
      .array(z.enum(CONTINUATION_KEY_SCOPES))
      .min(1)
      .default(["conversation", "operator"]),
  }).strict().optional(),
}).strict().refine(
  // The chosen `default` must appear in `supported` — otherwise the
  // host has no valid strategy to fall back to.
  c => c.supported.includes(c.default),
  {
    message: "continuation.default must be a member of continuation.supported",
  }
)

const mcpBlockSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  transport: z.enum(["stdio", "http", "sse"]),
  url: z.string().url().optional(),
}).strict()

const printConfigSchema = z.object({
  prompt_flag: z.string().optional(),
  output_format: z.array(z.string()).optional(),
  pre_prompt: z.array(z.string()).optional(),
  resume: z.object({
    flag: z.string(),
    kind: z.enum(["value", "boolean"]),
  }).strict().optional(),
  event_schema: z.enum(["claude-stream-json", "mastra-jsonl", "antigravity-stream-json", "jcode-ndjson"]).optional(),
}).strict().optional()

export const agentCliFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(80),
    id: z.string().regex(ID_PATTERN),
    description: z.string().min(1).max(2000),
    version: z.string().regex(SEMVER_PATTERN),
    bin: z.string().regex(BIN_PATTERN),
    bin_args: z.array(z.string()).optional(),
    // Always-on spawn env (merged before mode/option env, which can
    // override). See AgentCliDefinition.env — used by generic ACP agents.
    env: z.record(z.string(), z.string()).optional(),
    install: z.array(installMethodSchema).min(1),
    version_check: versionCheckSchema,
    setup: z.array(setupStepSchema).optional(),
    auth: authSchema.optional(),
    // Billing-auth resolver inputs (DECISION 3). `provider` is a CatalogProvider
    // id (validated against the catalog by the runtime resolver, not here, to
    // keep this generic doctype decoupled from @agentproto/model-catalog).
    provider: z.string().min(1).optional(),
    authSubscription: authSubscriptionSchema.optional(),
    // How this adapter receives a GATEWAY-routed bearer credential — see the
    // doc on AgentCliDefinition.gatewayAuth. Distinct from a gateway preset's
    // `keyEnv` (the providers-store lookup key) and from
    // authSubscription.setEnv (this adapter's own native bearer).
    gatewayAuth: z.object({
      setEnv: z.string().min(1),
    }).strict().optional(),
    // Auth-derivation axis (DECISION 3): true when the adapter's api-key auth
    // is derived from the requested model rather than a fixed `provider`
    // (e.g. `pi`, `opencode`, `mastracode`). When set, the runtime resolver
    // allows `"api-key"` mode on the model-derived direct endpoint and
    // includes it in eligibility manifests for by-model routers. DISTINCT
    // from `routeSelection` (the UI-facing route-choice axis).
    modelDerivedApiKey: z.boolean().optional(),
    // UI-facing route-choice axis (AIP-45 launch-menu drill-down, WP1).
    // Absent ⇒ "free" (route is an independent choice); "derived-from-model"
    // means the endpoint falls out of the model id's vendor prefix. DISTINCT
    // from `modelDerivedApiKey` (the auth-derivation axis) — see the field
    // doc on AgentCliDefinition.routeSelection.
    routeSelection: z.enum(["free", "derived-from-model"]).optional(),
    authEnforce: z.enum(["always", "when-configured"]).optional(),
    sandbox: z.union([z.string(), z.record(z.string(), z.unknown())]),
    runner: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    protocol: z.enum(["acp", "mcp", "proprietary", "print"]),
    acp: z.string().optional(),
    mcp: mcpBlockSchema.optional(),
    adapter: z.string().regex(ADAPTER_PATTERN).optional(),
    print: printConfigSchema,
    session: sessionSchema.optional(),
    models: modelsSchema.optional(),
    capabilities: capabilitiesSchema.optional(),
    modes: z.array(modeSchema).optional(),
    options: z.array(optionSchema).optional(),
    // AIP-45 gateway presets this adapter can drive (merged into the
    // provider-preset catalog; built-in wins on id collision).
    presets: z.array(presetSchema).optional(),
    continuation: continuationSchema.optional(),
    requires: z.object({
      os: z.array(z.enum(["darwin", "linux", "windows"])).optional(),
      arch: z.array(z.enum(["x64", "arm64", "x86", "arm"])).optional(),
      min_disk_mb: z.number().int().nonnegative().optional(),
      min_memory_mb: z.number().int().nonnegative().optional(),
    }).strict().optional(),
    examples: z.array(z.object({
      goal: z.string(),
      prompt: z.string(),
      note: z.string().optional(),
    }).strict()).optional(),
    tags: z.array(z.string().regex(TAG_PATTERN)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // Unique mode ids — duplicates would silently shadow.
    if (m.modes) {
      const seen = new Set<string>()
      for (const mode of m.modes) {
        if (seen.has(mode.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["modes"],
            message: `Duplicate mode id '${mode.id}' — mode ids must be unique within a manifest.`,
          })
        }
        seen.add(mode.id)
      }
    }
    // Unique setup step ids — duplicates would silently shadow each
    // other in the host's completion ledger, leading to one step
    // never re-prompting and another always re-prompting.
    if (m.setup) {
      const seen = new Set<string>()
      for (const step of m.setup) {
        if (seen.has(step.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["setup"],
            message: `Duplicate setup step id '${step.id}' — step ids must be unique within a manifest.`,
          })
        }
        seen.add(step.id)
      }
    }
    // Unique option ids — same reasoning as modes.
    if (m.options) {
      const seen = new Set<string>()
      for (const opt of m.options) {
        if (seen.has(opt.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options"],
            message: `Duplicate option id '${opt.id}' — option ids must be unique within a manifest.`,
          })
        }
        seen.add(opt.id)
      }
    }
    // continuation.default === "native-resume" requires capabilities.resumable: true.
    // Mirrors the JSON Schema's allOf rule so both validation paths
    // reject the same shape.
    if (
      m.continuation?.default === "native-resume" &&
      !m.capabilities?.resumable
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuation", "default"],
        message:
          "continuation.default === 'native-resume' requires capabilities.resumable: true.",
      })
    }
  })
  .describe(
    "Validates the YAML frontmatter portion of an AIP-45 AGENT-CLI.md manifest.",
  )

export type AgentCliFrontmatter = z.infer<typeof agentCliFrontmatterSchema>

// Re-export the per-call config schema for hosts that want to validate
// `OPERATOR.runtime.config` against a manifest at load time. Validation
// against the manifest's modes/options/continuation lives in
// `manifest/compose.ts` (the spawn-arg composer) — this schema covers
// only the SHAPE checks (types, enum values).
export const runtimeConfigSchema = z.object({
  mode: z.string().optional(),
  options: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]))
    .optional(),
  continuation: continuationStrategyIdSchema.optional(),
}).strict()

export type RuntimeConfigInput = z.infer<typeof runtimeConfigSchema>
