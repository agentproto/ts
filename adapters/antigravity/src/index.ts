/**
 * @agentproto/adapter-antigravity — AIP-45 adapter for Google Antigravity.
 *
 * Antigravity ships a headless CLI, `agy`, but NO ACP mode (open feature
 * request google-antigravity/antigravity-cli#31). So — exactly like the
 * `mastracode` adapter — this is a `protocol: "print"` (headless) arm, not
 * an ACP one. We spawn `agy -p "<prompt>" --output-format stream-json` per
 * turn and map its NDJSON events.
 *
 *   import { antigravity, antigravityRuntime } from "@agentproto/adapter-antigravity"
 *   const session = await antigravityRuntime().start()
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 *
 * ## Why a bespoke event schema (`antigravity-stream-json`)
 *
 * `agy`'s headless FLAG surface visibly mirrors Claude Code's (`-p`,
 * `--output-format stream-json`, `--continue`), which is a trap: the WIRE
 * events do NOT match Claude's `{ type: "system" | "assistant" | "result",
 * session_id }` taxonomy. Verified against the sample outputs at
 * antigravity.google/docs/cli/headless, every `agy` stream-json line is:
 *
 *   {"event":"init","conversation_id":"…","init":{…}}
 *   {"event":"step_update","step_update":{conversation_id,step_index,state,
 *       step_type,text_delta?,tool_name?,tool_info?,…}}
 *   {"event":"result","result":{conversation_id,status,response,error?,usage}}
 *
 * i.e. discriminated by `event` (not `type`), payload nested under a matching
 * key, session id a nested `conversation_id`, text as incremental
 * `text_delta` fragments. That is a genuinely different taxonomy, so the
 * print arm carries a dedicated `event_schema: "antigravity-stream-json"`
 * mapper (packages/driver/agent-cli/src/protocol/print-arm.ts) rather than
 * reusing the Claude one.
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"
import {
  deriveDeclaredCapabilities,
  type CapabilityStrategy,
} from "@agentproto/provider-kit"

export const antigravity: AgentCliHandle = defineAgentCli({
  name: "antigravity",
  id: "antigravity",
  description:
    "Google Antigravity's headless CLI (`agy`) — a multi-model coding agent " +
    "(Gemini 3.x, Claude, GPT-OSS) run non-interactively via `agy -p " +
    "--output-format stream-json`. No ACP mode yet (feature request " +
    "google-antigravity/antigravity-cli#31), so this is a print/headless arm.",
  version: "0.1.0",
  bin: "agy",
  // Not on npm — the only documented install is the official curl installer,
  // which drops `agy` into ~/.local/bin (antigravity.google/docs/cli/headless).
  install: [
    { method: "curl", url: "https://antigravity.google/cli/install.sh" },
  ],
  // `agy --version` is the conventional probe; the exact stdout is UNVERIFIED
  // (the headless flag table doesn't document a --version flag), so the range
  // is deliberately permissive. Tighten once a real version string is known.
  version_check: {
    cmd: "agy --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.1.0",
    timeout_ms: 15_000,
  },
  // Antigravity authenticates through the OS keyring + a Google Sign-In
  // browser flow ONLY — there is no documented API-key environment variable.
  // Headless runs reuse the cached credentials, so the user must have run
  // `agy` interactively once on this machine; a non-interactive run with no
  // cached login exits with an "authentication required" error. Nothing to
  // inject or scrub here — see ./SECRETS.md.
  auth: {
    ref: "./SECRETS.md",
  },
  sandbox: "./SANDBOX.md",
  protocol: "print",
  print: {
    // `agy -p "<prompt>"` runs a single prompt non-interactively.
    prompt_flag: "-p",
    output_format: ["--output-format", "stream-json"],
    // No Claude-style `--no-interactive`; `-p` already selects headless.
    pre_prompt: [],
    // `--conversation <id>` resumes a specific prior run by its
    // `conversation_id`. (`--continue`/`-c` resumes the *most recent*, but a
    // value-carrying flag is what the print arm wires from the captured id.)
    resume: { flag: "--conversation", kind: "value" },
    // See the file header + print-arm.ts: agy's events are `{event: …}`
    // envelopes, NOT Claude's `{type: …}` — hence its own mapper.
    event_schema: "antigravity-stream-json",
  },
  session: {
    // The print arm spawns a fresh `agy` per turn; continuity comes from
    // `--conversation <id>`, not a long-lived process.
    mode: "ephemeral",
    idle_timeout_ms: 1_800_000,
    context_carryover: false,
  },
  // No `models` block by design. The docs' `agy models` output shows real
  // slugs (e.g. `gemini-3.5-flash-medium`, `claude-sonnet-4-6`), but the list
  // is version-dependent and only partially documented, and every model is
  // served through Antigravity's own backend under ONE Google identity — not
  // a per-provider api-key route the catalog could bill. Declaring a fixed
  // `models.allowed`/`provider` here would assert routing facts we haven't
  // verified; the honest surface is the free-form `model` option below, which
  // forwards any slug from `agy models` straight to `--model`.
  capabilities: {
    streaming: true,
    tool_calls: true,
    // agy runs subagents (`agy agents`, background tasks); step_updates carry
    // `subagent_info`. We don't surface each subagent as its own StreamEvent,
    // but the capability is real.
    sub_agents: true,
    file_io: true,
    // Unverified — declared false rather than overclaiming.
    multimodal: false,
    // `agy --conversation <id>` genuinely resumes a prior conversation
    // (docs: "Resume prior context with --continue … or --conversation with
    // an ID from a previous run's conversation_id"). `print.resume` drives it.
    resumable: true,
    bidirectional: false,
  },
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Model slug for this run (see `agy models`), e.g. " +
        "`gemini-3.5-flash-medium` or `claude-sonnet-4-6`. Forwarded to " +
        "`--model`. Headless mode fails loudly on an unknown slug rather than " +
        "silently falling back.",
      bin_args_template: ["--model", "{value}"],
    },
    {
      id: "effort",
      type: "enum",
      enum: ["low", "medium", "high"],
      description: "Reasoning effort passed to `agy --effort`.",
      bin_args_template: ["--effort", "{value}"],
    },
    {
      id: "agent",
      type: "string",
      description:
        "Agent to run this prompt as (see `agy agents`). Forwarded to `--agent`.",
      bin_args_template: ["--agent", "{value}"],
    },
    {
      id: "print_timeout",
      type: "string",
      description:
        "Maximum time `agy` waits for a response, as a duration string " +
        "(e.g. `15m`). Forwarded to `--print-timeout` (default 5m).",
      bin_args_template: ["--print-timeout", "{value}"],
    },
    {
      id: "dangerously_skip_permissions",
      type: "boolean",
      description:
        "Auto-approve EVERY tool call (file writes, command execution) for " +
        "this run via `--dangerously-skip-permissions`. Off by default; " +
        "prefer scoped `permissions.allow` rules in agy's settings.json.",
      bin_args_append_when_true: ["--dangerously-skip-permissions"],
    },
    {
      id: "terminal_sandbox",
      type: "boolean",
      description:
        "Run agy with its terminal sandbox restrictions enabled (`--sandbox`).",
      bin_args_append_when_true: ["--sandbox"],
    },
  ],
  continuation: {
    default: "none",
    supported: ["none", "transcript", "native-resume"],
  },
  metadata: {
    acp: {
      checked: "2026-08-06",
      result:
        "Antigravity has no ACP mode. Tracked upstream as feature request " +
        "google-antigravity/antigravity-cli#31; until it ships this adapter " +
        "stays a print/headless arm.",
    },
    models: {
      checked: "2026-08-06",
      result:
        "`agy models` (per antigravity.google/docs/models + the headless docs) " +
        "lists slugs like gemini-3.6-flash-high, gemini-3.6-flash-medium, " +
        "gemini-3.5-flash-medium, gemini-3.1-pro-high, claude-sonnet-4-6 — " +
        "plus GPT-OSS variants. The full list is version-dependent and only " +
        "partially documented, so no fixed `models.allowed` is declared; pass " +
        "any slug through the `model` option.",
    },
    auth: {
      checked: "2026-08-06",
      result:
        "OS keyring + Google Sign-In browser flow only; no documented API-key " +
        "env var. Run `agy` interactively once to cache credentials before any " +
        "headless run.",
    },
  },
  tags: ["antigravity", "agy", "google", "print", "agent-runtime", "coding"],
})

export function antigravityRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(antigravity)
}

/**
 * Antigravity exposes no per-provider api-key store to discover (auth is a
 * keyring-backed Google login), so there are no providers to enrich — the
 * capability report stays the manifest projection. The one honest override is
 * the print arm's application contract: model/posture are baked into the spawn
 * argv (`--model`, options), applied per fresh subprocess, so a live switch is
 * `arg`-based and uncoupled — same as the `mastracode` print arm.
 */
export const antigravityCapabilities: CapabilityStrategy = async (def) => {
  const base = deriveDeclaredCapabilities(def)
  return {
    ...base,
    application: { modelApply: "arg", postureApply: "arg", coupled: false },
  }
}

export type { AgentCliHandle, AgentCliRuntime }
