/**
 * @agentproto/adapter-mastra-controller: AIP-45 adapter for a Mastra
 * `AgentController` (`@mastra/core/agent-controller`) declared by a
 * `mastra.agent-controller/v1` manifest.
 *
 * This is a `protocol: "proprietary"` manifest: `createAgentCliRuntime`
 * skips the subprocess spawn and dynamic-imports `adapter` (this package),
 * calling its exported `createAgentCliClient(definition)` factory.
 *
 * The client builds the controller from the session's manifest (the
 * `manifest` option), opens one session in the requested mode (the
 * `controller_mode` option, `connect({ mode })`, else the manifest default)
 * and maps its events to AIP-45 stream events. The controller's modes are
 * not static AIP-45 `modes` (those are context modes composed at spawn):
 * they come from the manifest at session time, as the client's
 * `availableModes`, switched with `setSessionMode`. Tool approvals,
 * `ask_user` questions and `submit_plan` plan approvals surface as
 * `agent-prompt` events answered with `respondPermission`. `capabilities`
 * claims only what this release does: streaming and tool calls. See
 * MASTRA-CONTROLLER.md.
 */

import { defineHarness, type AgentCliHandle } from "@agentproto/harness"

export const mastraController: AgentCliHandle = defineHarness({
  name: "Mastra AgentController",
  id: "mastra-controller",
  description:
    "A Mastra AgentController (@mastra/core/agent-controller) built in-process from a " +
    "mastra.agent-controller/v1 manifest: modes with plan to execute transitions, " +
    "subagents, permissions, tool approvals, questions and plan approvals.",
  version: "0.0.0",
  // No binary is ever spawned for a proprietary arm. `bin` is required by
  // the AIP-45 schema regardless, so this is a documented placeholder.
  bin: "in-process",
  install: [{ method: "npm", package: "@agentproto/adapter-mastra-controller" }],
  version_check: {
    cmd: "npm view @mastra/core version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    // Matches this package's `@mastra/core` peerDependency range.
    range: ">=1.60.0 <2",
    timeout_ms: 15_000,
  },
  sandbox: {
    model: "in-process",
    note:
      "Runs inside the host process: there is no subprocess boundary to sandbox. " +
      "Tool access will be whatever the manifest's permissions and the host's " +
      "resolved tools grant, with the host process's OS permissions.",
  },
  protocol: "proprietary",
  adapter: "@agentproto/adapter-mastra-controller",
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: false,
    file_io: false,
    multimodal: false,
    resumable: false,
    bidirectional: false,
  },
  modes: [],
  options: [
    {
      id: "manifest",
      type: "string",
      description:
        "Path to the mastra.agent-controller/v1 manifest (markdown with YAML frontmatter), " +
        "absolute or relative to the session cwd. Required.",
      env: { AGENTPROTO_MASTRA_CONTROLLER_MANIFEST: "{value}" },
    },
    {
      id: "controller_mode",
      type: "string",
      description:
        "Controller mode to enter at spawn, one of the manifest's modes[].id. " +
        "Default: the manifest's default mode.",
      env: { AGENTPROTO_MASTRA_CONTROLLER_MODE: "{value}" },
    },
  ],
  tags: ["mastra", "agent-controller", "proprietary", "in-process", "agent-runtime"],
})

export {
  createAgentCliClient,
  MANIFEST_ENV_KEY,
  MODE_ENV_KEY,
  META_PLAN,
  META_REQUEST,
  META_SUSPEND_PAYLOAD,
  META_TRANSITIONS_TO,
  type MastraControllerClientOptions,
  type MastraControllerSessionState,
} from "./client.js"
export {
  assertMastraCoreVersion,
  createAgentControllerHost,
  MIN_MASTRA_CORE_VERSION,
  ResolvedValueError,
  UnresolvedReferenceError,
  UnsupportedMastraCoreError,
  type AgentControllerHost,
  type AgentControllerHostDefaults,
  type AgentControllerHostOptions,
  type ControllerModel,
  type ControllerResolver,
  type ResolverContext,
} from "./host.js"
export {
  CONTROLLER_MANIFEST_ID,
  LEGACY_HARNESS_MANIFEST_ID,
  ControllerManifestError,
  ControllerManifestSchema,
  ControllerModeSchema,
  ControllerModelsSchema,
  ControllerOMConfigSchema,
  ControllerSubagentSchema,
  PermissionRulesSchema,
  ResolverRefSchema,
  parseControllerManifest,
  type ControllerManifest,
  type ControllerManifestIssue,
  type ControllerMode,
  type ControllerModels,
  type ControllerOMConfig,
  type ControllerSubagent,
  type PermissionRules,
  type ResolverRef,
} from "./manifest.js"
export { controllerManifestJsonSchema } from "./json-schema.js"
export type { AgentCliHandle }
