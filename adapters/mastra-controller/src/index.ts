/**
 * @agentproto/adapter-mastra-controller: AIP-45 adapter for a Mastra
 * `AgentController` (`@mastra/core/agent-controller`) declared by a
 * `mastra.agent-controller/v1` manifest.
 *
 * This is a `protocol: "proprietary"` manifest: `createAgentCliRuntime`
 * skips the subprocess spawn and dynamic-imports `adapter` (this package),
 * calling its exported `createAgentCliClient(definition)` factory.
 *
 * SCAFFOLD (E48 PR 1): the manifest schema and parser are real; the client
 * is shape only and throws `not implemented yet (E48 PR 2)` on any call
 * that needs a live controller. Modes are empty here because they come
 * from the manifest at session time (PR 2), and `capabilities` claims
 * nothing this release does not do. See MASTRA-CONTROLLER.md.
 */

import { defineHarness, type AgentCliHandle } from "@agentproto/harness"

export const mastraController: AgentCliHandle = defineHarness({
  name: "Mastra AgentController",
  id: "mastra-controller",
  description:
    "A Mastra AgentController (@mastra/core/agent-controller) built in-process from a " +
    "mastra.agent-controller/v1 manifest: modes with plan to execute transitions, " +
    "subagents, permissions. Scaffold only: the live controller lands in E48 PR 2.",
  version: "0.0.0",
  // No binary is ever spawned for a proprietary arm. `bin` is required by
  // the AIP-45 schema regardless, so this is a documented placeholder.
  bin: "in-process",
  install: [{ method: "npm", package: "@agentproto/adapter-mastra-controller" }],
  version_check: {
    cmd: "npm view @mastra/core version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    // Matches this package's `@mastra/core` peerDependency range.
    range: ">=1.59.0 <2",
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
    streaming: false,
    tool_calls: false,
    sub_agents: false,
    file_io: false,
    multimodal: false,
    resumable: false,
    bidirectional: false,
  },
  modes: [],
  tags: ["mastra", "agent-controller", "proprietary", "in-process", "agent-runtime"],
})

export {
  createAgentCliClient,
  NotImplementedYetError,
  type MastraControllerSessionState,
} from "./client.js"
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
