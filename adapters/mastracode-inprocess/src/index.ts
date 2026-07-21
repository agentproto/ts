/**
 * @agentproto/adapter-mastracode-inprocess — AIP-45 adapter for Mastra Code,
 * driven in-process via the `mastracode` / `mastracode/headless` SDK
 * instead of spawning a subprocess.
 *
 * This is a `protocol: "proprietary"` manifest: `createAgentCliRuntime`
 * skips the subprocess spawn entirely for this protocol and instead
 * dynamic-imports `adapter` (this very package) and calls its exported
 * `createAgentCliClient(definition)` factory — see
 * `createProprietaryProtocolArm` in `@agentproto/driver-agent-cli`. The
 * factory itself lives in `./client.ts`; this file only builds and
 * exports the manifest handle.
 *
 *   import { mastracodeInprocess, mastracodeInprocessRuntime } from "@agentproto/adapter-mastracode-inprocess"
 *   const session = await mastracodeInprocessRuntime().start()
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 *
 * Why a separate package from `@agentproto/adapter-mastracode` (the
 * `print` arm) rather than a second export of it — see
 * MASTRACODE-INPROCESS.md.
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

export const mastracodeInprocess: AgentCliHandle = defineAgentCli({
  name: "Mastra Code (in-process)",
  id: "mastracode-inprocess",
  description:
    "Mastra Code terminal coding agent driven in-process via the `mastracode` SDK " +
    "(createMastraCode + runMC) instead of spawning the CLI as a subprocess. Same " +
    "underlying agent as @agentproto/adapter-mastracode, no child process.",
  version: "0.1.0",
  // No binary is ever spawned for a proprietary arm — `bin` is required by
  // the AIP-45 schema regardless, so this is a documented placeholder
  // rather than a real executable. `createAgentCliRuntime` checks
  // `protocol === "proprietary"` and never reads this field.
  bin: "in-process",
  install: [{ method: "npm", package: "@agentproto/adapter-mastracode-inprocess" }],
  version_check: {
    cmd: "npm view mastracode version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    // Matches this package's pinned `mastracode` dependency (see package.json).
    range: ">=0.27.0",
    timeout_ms: 15_000,
  },
  auth: {
    state: {
      env: [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
      ],
    },
  },
  sandbox: {
    model: "in-process",
    note:
      "Runs inside the host process — there is no subprocess boundary to sandbox. " +
      "File and shell tool access is whatever Mastra Code's own tool policy grants " +
      "for this session, with the host process's OS permissions (not a separately " +
      "confined child). Storage and home dir ARE isolated per MASTRACODE-INPROCESS.md " +
      "so this arm's sessions never collide with a developer's own interactive " +
      "mastracode usage, but that isolation is not a security sandbox.",
  },
  protocol: "proprietary",
  adapter: "@agentproto/adapter-mastracode-inprocess",
  session: {
    mode: "resumable",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  // Same Mastra model router as @agentproto/adapter-mastracode: the provider
  // is read straight off each id's `<provider>/<id>` prefix (no adapter mode),
  // so the route falls out of the chosen model → derived-from-model.
  routeSelection: "derived-from-model",
  models: {
    default: "anthropic/claude-sonnet-4-5",
    // Anthropic is no longer advertised as a pickable escalation — only the
    // adapter's own default Claude model stays listed (repointing the default
    // is out of scope). The extra Sonnet + gateway dupe are dropped from the
    // menu; the free-form `model` option still accepts any id.
    allowed: [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.1",
      "openai/gpt-5.1-mini",
      "google/gemini-2.5-flash",
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: true,
    file_io: true,
    multimodal: false,
    // The composite "<resourceId>:<threadId>" sessionId round-trips through
    // `client.ts`'s connect(resumeSessionId) and has been verified to
    // recall prior-turn context across a fresh process (see README.md).
    resumable: true,
    bidirectional: false,
  },
  // Mode selection has no argv to append to (no spawn) — modes patch the
  // one channel `composeSpawn` threads through for every protocol
  // regardless: env. `client.ts` reads `AGENTPROTO_MASTRACODE_MODE` off
  // the composed env and switches the live session's mode before send().
  modes: [
    {
      id: "default",
      description: "Default headless mode. Mastra Code defaults to build mode when omitted.",
    },
    {
      id: "plan",
      description:
        "Plan-only mode — analyze architecture and propose implementation plans before writing code.",
      env: { AGENTPROTO_MASTRACODE_MODE: "plan" },
    },
    {
      id: "build",
      description:
        "Build mode — file edits and shell commands use Mastra Code's configured permissions.",
      env: { AGENTPROTO_MASTRACODE_MODE: "build" },
    },
    {
      id: "fast",
      description: "Fast mode — lower-latency answers and small edits.",
      env: { AGENTPROTO_MASTRACODE_MODE: "fast" },
    },
  ],
  // `model`/`effort` here are the two ids `createAgentCliRuntime` always
  // reads off `config.options` for the generic model/effort passthrough
  // (see `define-agent-cli.ts`) — declaring them is what lets a host pass
  // `agent_start({ model, effort })` without composeSpawn rejecting the
  // config as an unknown option. Both travel to `client.ts`'s connect()
  // directly (not via bin_args/env), so no `bin_args_template`/`env` patch
  // is declared on either.
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Provider/model override for this operator binding (e.g. `anthropic/claude-sonnet-4-5`).",
    },
    {
      id: "effort",
      type: "enum",
      enum: ["off", "low", "medium", "high", "xhigh"],
      description:
        "Thinking level, mapped 1:1 to Mastra Code's `thinkingLevel` run option.",
    },
  ],
  continuation: {
    default: "none",
    supported: ["none", "transcript", "native-resume"],
  },
  metadata: {
    proprietary: {
      checked: "2026-07-02",
      result:
        "Verified in-process against mastracode 0.27.0 / @mastra/core 1.48.0: a turn " +
        "returns real streamed content, and cross-process resume (kill the process, " +
        "start a fresh one, reattach via the composite sessionId) recalls prior-turn " +
        "context. See MASTRACODE-INPROCESS.md for the composite sessionId format.",
    },
  },
  tags: ["mastracode", "mastra", "proprietary", "in-process", "agent-runtime", "coding"],
})

export function mastracodeInprocessRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(mastracodeInprocess)
}

export { createAgentCliClient } from "./client.js"
export type { AgentCliHandle, AgentCliRuntime }
