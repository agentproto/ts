/**
 * Builds a runnable Mastra `AgentController` from an AIP-42 AGENT.md — either
 * a caller's file or a zero-config built-in default — wiring the model, the
 * markdown body as instructions, the SQLite memory/storage, and the workspace
 * toolset, then wrapping the built `Agent` as the controller's shared backing
 * agent. The ACP host drives controller sessions, not the raw agent stream.
 */

import { readFile } from "node:fs/promises"
import { agentFromManifest, parseAgentManifest } from "@agentproto/agent"
import { buildMastraAgent } from "@agentproto/mastra"
import type { MastraToolLike } from "@agentproto/mastra"
import { AgentController } from "@mastra/core/agent-controller"
import type {
  AgentControllerConfig,
  AgentControllerSubagent,
  BuiltinToolId,
  PermissionRules,
} from "@mastra/core/agent-controller"
import { Workspace } from "@mastra/core/workspace"
import type { Agent } from "@mastra/core/agent"
import { DaemonClient } from "./daemon-client.js"
import { makeDaemonTools } from "./daemon-tools.js"
import { AgentprotoSignalProvider } from "./signal-provider.js"
import type { MastraMemoryLike } from "./memory.js"
import { buildSqliteMemory, buildSqliteStore } from "./memory.js"
import { resolveMastraModel } from "./model-resolver.js"
import { DEFAULT_PERMISSION_RULES, toolCategoryResolver } from "./tool-categories.js"
import { resolveModes } from "./modes.js"
import { makeUnwiredToolStub, makeWorkspaceTools } from "./workspace-tools.js"

/** Cheap OpenRouter coder by default — this is the budget first-party arm,
 *  same rationale as the hermes default. Override with --model / env. */
export const DEFAULT_MODEL = "openrouter/z-ai/glm-5.2"

/** Tool ids the built-in default agent is granted (the workspace toolset). */
export const DEFAULT_TOOL_IDS = [
  "list_dir",
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
] as const

export interface AgentSourceOptions {
  /** Path to an AGENT.md. When omitted, the built-in default agent is used. */
  agentFile?: string
  /** Model id for the default agent (ignored when agentFile carries a model). */
  model?: string
  /** Workspace dir the tools are confined to. Defaults to `process.cwd()`. */
  cwd?: string
  /** When false, the `run_command` tool is withheld. Default true. */
  allowExec?: boolean
  /**
   * Extra tools merged over the built-in workspace toolset (extra wins on id
   * collision) — programmatic-only, for a host embedding this agent that
   * wants to grant tools the built-in toolset doesn't cover. No CLI flag.
   */
  extraTools?: Record<string, MastraToolLike>
  /**
   * `false` runs WP-1 parity: a single mode, no tool approvals, yolo
   * execution — exactly the old raw-stream behavior. Anything else (or
   * omitted) runs the plan/build/review modes with real tool approvals
   * (WP-3 default). The `AGENTPROTO_MASTRA_NO_MODES` env var is the
   * spawn-time equivalent of passing `false` here, for hosts that can't pass
   * this option directly (e.g. the CLI, which owns no `--no-modes` flag yet
   * — see this WP's report).
   */
  modes?: false | "default"
}

/** Truthy env-var check matching this adapter's existing `AGENTPROTO_MASTRA_NO_EXEC` convention. */
function envFlag(value: string | undefined): boolean {
  return Boolean(value)
}

/** The built-in AGENT.md used when no file is supplied. */
export function defaultAgentManifest(model: string): string {
  return [
    "---",
    "schema: agent/v1",
    "id: mastra-agent",
    "description: A first-party agentproto agent powered by Mastra.",
    `model: ${model}`,
    "version: 0.1.0",
    "tools:",
    ...DEFAULT_TOOL_IDS.map((id) => `  - ${id}`),
    "memory:",
    "  scope: per-conversation",
    "  retention_turns: 20",
    "---",
    "",
    "You are a capable, concise coding agent operating inside a workspace ",
    "directory. You can list, read, write, and edit files and run shell ",
    "commands there using your tools. Do exactly what the user asks — when ",
    "asked to reply with an exact string, reply with only that string.",
    "",
  ].join("\n")
}

/** Pull the id string out of an AIP-42 tool ref (string | { ref }). */
function toolRefId(ref: unknown): string | undefined {
  if (typeof ref === "string") return ref
  if (ref && typeof ref === "object" && typeof (ref as { ref?: unknown }).ref === "string") {
    return (ref as { ref: string }).ref
  }
  return undefined
}

/** Resolve the AGENT.md source for these options (file or built-in default). */
export async function resolveAgentSource(
  opts: AgentSourceOptions = {},
): Promise<string> {
  if (opts.agentFile) return readFile(opts.agentFile, "utf8")
  return defaultAgentManifest(opts.model ?? DEFAULT_MODEL)
}

/** Every AgentController built-in tool id — WP-1 parity mode disables them ALL
 *  so the controller adds nothing the raw-stream agent didn't have. Modes-on
 *  (the default, WP-3/WP-5) re-enables `submit_plan` and `subagent` — see
 *  `makeAgentFactory`. */
export const DISABLED_BUILTIN_TOOL_IDS: readonly BuiltinToolId[] = [
  "ask_user",
  "submit_plan",
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
  "subagent",
] as const

/** Built-in ids modes-on re-enables out of {@link DISABLED_BUILTIN_TOOL_IDS} —
 *  `submit_plan` (WP-3's plan-approval gate) and `subagent` (WP-5's in-process
 *  subagent spawner, backing {@link REVIEWER_SUBAGENT}). */
const REENABLED_BUILTIN_TOOL_IDS: readonly BuiltinToolId[] = ["submit_plan", "subagent"]

/** Read-only tool ids granted to the reviewer subagent — a reviewer that
 *  can only read code/diffs/tests and run the suite, never edit. `read_diff`
 *  and `run_tests` only exist in the controller's `tools` set when
 *  `allowExec` is true (see `makeWorkspaceTools`); AgentController silently
 *  has nothing to grant for an id absent from `tools` when exec is off, so
 *  the reviewer's toolset shrinks to `list_dir`/`read_file` in that case. */
const REVIEWER_ALLOWED_TOOL_IDS: readonly string[] = ["read_file", "read_diff", "run_tests", "list_dir"]

/**
 * In-process code-review subagent (WP-5), spawned via the `subagent` built-in
 * tool. `forked: true` clones the parent thread onto the subagent run so the
 * reviewer sees the same conversation context (what was asked, what changed,
 * why) instead of reviewing a diff cold — the plan's own rationale for this
 * subagent. Forked runs require the controller's `memory` to be configured;
 * that's true for the built-in default agent (its manifest declares a
 * `memory:` section — see `defaultAgentManifest`) but is only as true as
 * whatever AGENT.md a caller supplies via `agentFile` — an AGENT.md with no
 * `memory:` section leaves `config.memory` unset (see `makeAgentFactory`)
 * and a forked reviewer run would then have nothing to fork.
 */
const REVIEWER_SUBAGENT: AgentControllerSubagent = {
  id: "reviewer",
  name: "Code reviewer",
  description: "Reviews changes for correctness and reports findings.",
  instructions:
    "You are reviewing a change for correctness. Read the diff (`read_diff`) and the files it " +
    "touches, run the test suite (`run_tests`) if one exists, and report concrete findings: bugs, " +
    "missed edge cases, and test gaps. You cannot edit files — report findings back to the caller " +
    "instead of trying to fix them yourself.",
  allowedControllerTools: [...REVIEWER_ALLOWED_TOOL_IDS],
  forked: true,
}

/** Session state the controller carries for us (see `initialState` below). */
interface AdapterControllerState {
  /** WP-1 parity mode only: skips tool approvals entirely. Unset when modes are on. */
  yolo?: boolean
  /** Modes-on default: seeded from {@link DEFAULT_PERMISSION_RULES}, read by `session.permissions`. */
  permissionRules?: PermissionRules
}

/**
 * A lazy factory: parses the AGENT.md, builds the Mastra agent with the model
 * resolver, SQLite memory, the markdown body as instructions, and the
 * workspace toolset (matched by tool id), then wraps it in an
 * `AgentController` the ACP host creates sessions on.
 */
export function makeAgentFactory(
  opts: AgentSourceOptions = {},
): () => Promise<{ controller: AgentController<AdapterControllerState> }> {
  return async () => {
    const source = await resolveAgentSource(opts)
    const { frontmatter, body } = parseAgentManifest(source)
    const handle = agentFromManifest({ frontmatter, body })

    const cwd = opts.cwd ?? process.cwd()
    const workspaceTools = makeWorkspaceTools({
      cwd,
      allowExec: opts.allowExec,
      extraTools: opts.extraTools,
    })

    // One LibSQL store shared between the agent's Memory and the controller's
    // storage — two stores on one SQLite file would contend on writes.
    const store = buildSqliteStore()
    let memory: MastraMemoryLike | undefined

    const { agent } = await buildMastraAgent(handle, {
      resolveModel: (ref) => resolveMastraModel(ref),
      // Match each declared tool ref against the workspace toolset by id. A
      // ref with no matching executor still resolves — to a stub that fails
      // fast and clearly on call — rather than being dropped: a dropped ref
      // leaves the model unable to see it at all, and (if the model still
      // tries the name from AGENT.md prose) surfaces as an opaque provider
      // NoSuchToolError this adapter's ACP layer silently swallows (see
      // tool-call-map.ts), which is how a declared-but-unwired tool used to
      // hang a turn with zero recorded tool calls instead of failing fast.
      resolveTool: (ref) => {
        const id = toolRefId(ref)
        if (!id) return undefined
        const tool = workspaceTools[id]
        if (tool) return { name: id, tool }
        console.warn(
          `[@agentproto/adapter-mastra-agent] agent '${handle.id}' declares tool '${id}' but no ` +
            `executor is wired for it in this adapter's workspace toolset — calls to it will fail ` +
            `immediately instead of hanging. Wire it in workspace-tools.ts or pass it via extraTools.`,
        )
        return { name: id, tool: makeUnwiredToolStub(id) }
      },
      buildMemory: (config) => (memory = buildSqliteMemory(config, process.env, store)),
      // The markdown body is the agent's primary system prompt (AIP-42).
      body,
    })

    // `false` (or the env var) selects WP-1 parity; anything else keeps the
    // WP-3 default of real plan/build/review modes with tool approvals.
    const modesEnabled = opts.modes !== false && !envFlag(process.env.AGENTPROTO_MASTRA_NO_MODES)
    const { modes, defaultModeId } = modesEnabled
      ? resolveModes(body)
      : { modes: [{ id: "main", metadata: { default: true } }], defaultModeId: "main" }

    // Daemon sub-agent-spawning tools (WP-5) and the daemon signal provider
    // (WP-6) are additive, modes-on only — parity mode stays exactly the
    // WP-1 raw-stream toolset. One `DaemonClient` is shared between them
    // (cheap to build: no network call happens until a tool executes or a
    // watch exists, and discovery runs lazily).
    let tools = workspaceTools
    if (modesEnabled) {
      const daemonClient = new DaemonClient({ cwd })
      tools = { ...workspaceTools, ...makeDaemonTools({ client: daemonClient }) }

      // WP-6: attach the AgentprotoSignalProvider MANUALLY. `buildMastraAgent`
      // owns the `new Agent(...)` call and has no `signals` passthrough, so we
      // replicate here exactly what `Agent`'s constructor does for
      // `config.signals` (see @mastra/core dist, agent ctor):
      //   1. `provider.connect(this)`      — done below.
      //   2. `provider.startPolling()`     — done below (a no-op timer until a
      //      subscription exists; the base class skips poll() with zero subs,
      //      so an unwatched provider never even attempts daemon discovery —
      //      no daemon just means the first real poll warns once and the
      //      provider stays dormant).
      //   3. `provider.start?.()`          — our provider defines none.
      //   4. merge `getInputProcessors()`/`getOutputProcessors()` — our
      //      provider exposes none, nothing to replicate.
      //   5. merge `getTools()` into the agent's toolset — replicated by
      //      merging into the CONTROLLER `tools` below instead, which is the
      //      surface controller sessions actually execute against (agent-level
      //      and controller-level tools overlap onto the same executors here,
      //      same as the workspace toolset).
      // One thing the constructor path would ALSO have done that we don't:
      // `agent.__registerMastra` forwards the Mastra instance to providers in
      // `config.signals`; a manually-connected provider never receives it.
      // Ours never reads `this.mastra`, so nothing is lost.
      const signalProvider = new AgentprotoSignalProvider({ client: daemonClient })
      signalProvider.connect(agent as unknown as Agent)
      signalProvider.startPolling()
      tools = { ...tools, ...signalProvider.getTools() }
    }

    const config: AgentControllerConfig<AdapterControllerState> = {
      id: "agentproto-native",
      // The AGENT.md-built agent backs every mode; parity mode has exactly
      // one mode and layers no mode instructions, so runs behave as the raw
      // agent did.
      agent: agent as AgentControllerConfig["agent"],
      modes,
      defaultModeId,
      // Thread rows + per-thread settings persist to the same SQLite file the
      // agent's Memory writes messages to.
      storage: store,
      // Our hardened workspace toolset (+ daemon tools, modes-on) stays the
      // tool surface. The backing agent already carries the AGENT.md-declared
      // subset; controller-level tools are an additive toolset, so ids
      // overlap onto the same executors.
      tools: tools as AgentControllerConfig["tools"],
      // Parity mode disables every built-in controller tool and skips tool
      // approvals entirely (`yolo: true` keeps `requireToolApproval` off so
      // tools execute pass-through exactly as the raw stream did). Modes-on
      // re-enables `submit_plan` (the plan mode's approval gate) and
      // `subagent` (WP-5's in-process reviewer, see `REVIEWER_SUBAGENT`), and
      // seeds real per-category tool-approval policy instead.
      disableBuiltinTools: modesEnabled
        ? DISABLED_BUILTIN_TOOL_IDS.filter((id) => !REENABLED_BUILTIN_TOOL_IDS.includes(id))
        : [...DISABLED_BUILTIN_TOOL_IDS],
      toolCategoryResolver,
      initialState: modesEnabled ? { permissionRules: DEFAULT_PERMISSION_RULES } : { yolo: true },
      // `Session` construction hard-requires a `Workspace` instance
      // (`createSession` throws "A session requires a valid workspace
      // instance" without one) — but a *filesystem/sandbox*-backed Workspace
      // makes Mastra auto-inject its own `mastra_workspace_*` file/exec tools
      // into every run, duplicating our own hardened workspace toolset. A
      // skills-only Workspace (no filesystem, no sandbox) satisfies the
      // former without triggering the latter: `createWorkspaceTools` only
      // adds filesystem/sandbox tools, so this config contributes none.
      workspace: new Workspace({ skills: () => [] }),
    }
    if (memory) config.memory = memory
    if (modesEnabled) config.subagents = [REVIEWER_SUBAGENT]

    return { controller: new AgentController<AdapterControllerState>(config) }
  }
}
