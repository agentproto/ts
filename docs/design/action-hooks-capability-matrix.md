# Native hook capability matrix

Pinned commit: d6641f7eaba69c6274eff55c502b5602e93a89fc
Date: 2026-10-23

This document inventories the AIP-45 adapters in this repo, records only
hook behaviour that was read from the upstream vendor documentation at the
pinned commit date, and proposes `NativeHookCapability` entries for the
AIP-71 bridge. Vendor memory is not used. Anything not backed by fetched
documentation or repo code is listed under NOT VERIFIED at the end.

## Method

- Adapter inventory and spawn wiring come from this repo at the pinned
  commit.
- Native hook claims come from the official documentation URLs quoted in
  each section. Fetched pages are cited as `DOC <url> "<quote>"`.
- A proposed capability is emitted only when the documentation supports
  every AIP-71 field. Otherwise the cell says `unavailable` or
  `NOT VERIFIED`.
- AIP-37 portable event names are taken from the Harness extension
  lifecycle, Tool / command lifecycle, Agent turn lifecycle and Conversation
  lifecycle sections of `aip-37.mdx`:
  DOC https://raw.githubusercontent.com/agentproto/agentproto/main/specs/aip-37.mdx "#### Harness extension lifecycle"
  DOC https://raw.githubusercontent.com/agentproto/agentproto/main/specs/aip-37.mdx "| `tool-call` | Before a tool is invoked. |"

## Step 1: adapters in this repo

The two top-level adapter trees are `adapters/` (26 packages) and
`packages/driver/` (the shared `agent-cli` driver). Packages whose names
contain `adapter` are all under `adapters/`.

### Agent-CLI adapters (AIP-45 manifests)

| Adapter | Upstream CLI it wraps | Evidence |
| --- | --- | --- |
| claude-code | Anthropic Claude Code via `@agentclientprotocol/claude-agent-acp` | adapters/claude-code/package.json:4 `AIP-45 AGENT-CLI adapter for Anthropic's Claude Code`; spawn argv at adapters/claude-code/src/index.ts:93 `bin_args: ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"],` |
| codex | OpenAI Codex CLI via `@agentclientprotocol/codex-acp` | adapters/codex/package.json:4 `AIP-45 AGENT-CLI adapter for OpenAI's Codex CLI`; spawn argv at adapters/codex/src/index.ts:42 `bin_args: ["-y", "@agentclientprotocol/codex-acp@1.13.1"],` |
| opencode | sst/opencode (`opencode acp`) | adapters/opencode/package.json:4 `AIP-45 AGENT-CLI adapter for sst/opencode`; spawn argv at adapters/opencode/src/index.ts:109 `bin_args: ["-y", "opencode-ai", "acp", "--print-logs", "--log-level", "ERROR"],` |
| gemini | Google Gemini CLI (`gemini --experimental-acp`) | adapters/gemini/package.json:4 `AIP-45 AGENT-CLI adapter for Google's Gemini CLI`; spawn argv at adapters/gemini/src/index.ts:43 `bin_args: ["--experimental-acp"],` |
| copilot-cli | GitHub Copilot CLI (`copilot --acp --stdio`) | adapters/copilot-cli/package.json:4 `AIP-45 AGENT-CLI adapter for GitHub's official Copilot CLI`; spawn argv at adapters/copilot-cli/src/index.ts:48 `bin_args: ["--acp", "--stdio"],` |
| grok-cli | xAI Grok Build CLI (`grok agent stdio`) | adapters/grok-cli/package.json:4 `AIP-45 AGENT-CLI adapter for xAI's Grok Build CLI`; spawn argv at adapters/grok-cli/src/index.ts:60 `bin_args: ["agent", "stdio"],` |
| openclaw | OpenClaw (`openclaw acp`) | adapters/openclaw/package.json:4 `AIP-45 AGENT-CLI adapter for OpenClaw`; spawn argv at adapters/openclaw/src/index.ts:39 `bin_args: ["acp"],` |
| hermes | Nous Research Hermes Agent (`hermes acp`) | adapters/hermes/package.json:4 `AIP-45 AGENT-CLI adapter for Nous Research's Hermes Agent`; spawn argv at adapters/hermes/src/index.ts:85 `bin_args: ["acp"],` |
| antigravity | Google Antigravity headless CLI (`agy`) | adapters/antigravity/package.json:4 `AIP-45 AGENT-CLI adapter for Google Antigravity's headless CLI`; binary at adapters/antigravity/src/index.ts:58 `bin: "agy",` |
| jcode | 1jehuang/jcode (`jcode run`) | adapters/jcode/package.json:4 `AIP-45 adapter for 1jehuang/jcode`; spawn argv at adapters/jcode/src/index.ts:90 `bin_args: ["run"],` |
| mastracode | Mastra Code headless CLI (`npx -y mastracode`) | adapters/mastracode/package.json:4 `AIP-45 AGENT-CLI adapter for Mastra Code`; spawn argv at adapters/mastracode/src/index.ts:72 `bin_args: ["-y", "mastracode"],` |
| mastracode-inprocess | Mastra Code SDK, not a child process | adapters/mastracode-inprocess/package.json:4 `AIP-45 AGENT-CLI adapter for Mastra Code driven in-process`; placeholder binary at adapters/mastracode-inprocess/src/index.ts:47 `bin: "in-process",` |
| pi | earendil-works/pi (`pi --mode rpc`) | adapters/pi/package.json:4 `AIP-45 AGENT-CLI adapter for earendil-works/pi`; binary at adapters/pi/src/index.ts:116 `bin: "pi",` |
| claude-sdk | Claude Code harness through the Claude Agent SDK, behind ACP | adapters/claude-sdk/package.json:4 `runs Claude Code's agent harness as a library via the Claude Agent SDK`; spawn argv at adapters/claude-sdk/src/index.ts:85 `bin_args: [cliEntry, "acp"],` |
| claude-code-cloud | Anthropic Claude Code cloud sessions through `claude --cloud` | adapters/claude-code-cloud/package.json:4 `AIP-66 managed-cloud-agent adapter for Anthropic Claude Code cloud sessions`; spawn argv at adapters/claude-code-cloud/src/index.ts:64 `bin_args: [acpBin],` |
| mastra-agent | This repo's own Mastra agent, no external CLI | adapters/mastra-agent/package.json:4 `first-party agentproto agent`; spawn argv at adapters/mastra-agent/src/index.ts:34 `bin_args: [cliEntry, "acp"],` |

### Non-agent-CLI adapters

These packages implement tool, browser, code-brain, knowledge or framework
surfaces, not an AIP-45 interactive agent CLI.

| Adapter | Surface | Evidence |
| --- | --- | --- |
| ai-sdk | AI SDK tool adapter | adapters/ai-sdk/package.json:4 `AI SDK adapter for AIP-30 ToolImplementations` |
| browser | Browser service adapter facade | adapters/browser/package.json:4 `browser service adapters for agentproto` |
| browser-camofox | Camofox browser provider | adapters/browser-camofox/package.json:4 `Camofox browser provider` |
| browser-chrome | Chrome browser provider | adapters/browser-chrome/package.json:4 `System Chrome providers` |
| browser-chromium | Chromium browser provider | adapters/browser-chromium/package.json:4 `Chromium browser provider` |
| code-brain-gbrain | Code-intelligence provider | adapters/code-brain-gbrain/package.json:4 `Impure code-brain adapter` |
| knowledge-corpus | Corpus knowledge provider | adapters/knowledge-corpus/package.json:4 `Composable knowledge adapter` |
| knowledge-files | Files knowledge provider | adapters/knowledge-files/package.json:4 `Pure, zero-runtime knowledge adapter` |
| knowledge-gbrain-doc | gbrain document knowledge provider | adapters/knowledge-gbrain-doc/package.json:4 `Knowledge adapter:` |
| knowledge-qdrant | Qdrant knowledge provider | adapters/knowledge-qdrant/package.json:4 `Knowledge adapter:` |
| mastra | Mastra tool adapter | adapters/mastra/package.json:4 `Generic Mastra adapter for AIP-14 ToolHandles` |

## Step 2: official native hook evidence

The only upstream CLIs covered here are the ones whose official docs were
fetched successfully and whose adapters exist in this repo. OpenCode's
native seam is a plugin API, not a declarative hook configuration, so its
evidence is recorded separately and its matrix cells stay `unavailable` for
the AIP-71 handler enum.

### Claude Code

Sources:

- DOC https://code.claude.com/docs/en/hooks.md "Hooks are user-defined shell commands, HTTP endpoints, MCP tool calls, LLM prompts, or subagents"
- DOC https://code.claude.com/docs/en/hooks.md "Hooks are defined in JSON settings files."
- DOC https://code.claude.com/docs/en/hooks.md "Exit with code 2 to block the action."
- DOC https://code.claude.com/docs/en/hooks.md "When an event fires, its matching hooks run in parallel."
- DOC https://code.claude.com/docs/en/hooks.md "Once an async hook is running in the background, Claude Code doesn't enforce"
- DOC https://code.claude.com/docs/en/hooks.md "The `additionalContext` field passes a string from your hook into Claude's context window."
- DOC https://code.claude.com/docs/en/hooks.md "Exit code 2 isn't honored for this event and the permission flow proceeds unchanged."
- DOC https://code.claude.com/docs/en/hooks.md "SessionEnd hooks have no decision control."

Configuration mechanism: JSON settings files at `~/.claude/settings.json`,
`.claude/settings.json`, `.claude/settings.local.json`, managed policy
settings, plugin `hooks/hooks.json`, skill frontmatter and subagent
frontmatter. Handler types in the official docs are `command`, `http`,
`mcp_tool`, `prompt` and `agent`. Command hooks accept `async: true`.
`PermissionRequest` can deny through `hookSpecificOutput.decision.behavior`,
not through exit code 2.

| Native event | Fires | Can block, and how | Handler types | Async | Context into next turn |
| --- | --- | --- | --- | --- | --- |
| SessionStart | Session begins or resumes | No, stderr only | command, http, mcp, prompt, agent | command async | append via `additionalContext` |
| UserPromptSubmit | Prompt submitted before processing | Yes, exit 2 or `decision: "block"` | command, http, mcp, prompt, agent | command async | append |
| PreToolUse | Before a tool call | Yes, exit 2 or `permissionDecision: "deny"` | command, http, mcp, prompt, agent | command async | append |
| PermissionRequest | Tool call needs a permission decision | Yes, `decision.behavior: "deny"`; exit 2 is not honored | command, http, mcp, prompt, agent | command async | none documented |
| PostToolUse | After a tool call succeeds | No, tool already ran | command, http, mcp, prompt, agent | command async | append |
| SubagentStart | Subagent spawned | No | command, http, mcp, prompt, agent | command async | append |
| SubagentStop | Subagent finishes | Yes, exit 2 or `decision: "block"`, prevents stop | command, http, mcp, prompt, agent | command async | append |
| Stop | Claude finishes responding | Yes, exit 2 or `decision: "block"`, prevents stop | command, http, mcp, prompt, agent | command async | append |
| PreCompact | Before context compaction | Yes, top-level `decision: "block"` | command, http, mcp, prompt, agent | command async | none documented |
| PostCompact | After context compaction | No | command, http, mcp, prompt, agent | command async | none documented |
| SessionEnd | Session terminates | No, no decision control | command, http, mcp, prompt, agent | command async | none |

There is no documented turn-start native event. `Notification`,
`PostToolUseFailure`, `Setup`, `ConfigChange`, `CwdChanged`,
`InstructionsLoaded`, `WorktreeCreate`, `WorktreeRemove`, `TaskCreated`,
`TaskCompleted`, `TeammateIdle`, `PreModelSwitch`, `PostModelSwitch`,
`Elicitation` and `ElicitationResult` are outside the requested portable
mapping.

### Codex

Sources:

- DOC https://learn.chatgpt.com/docs/hooks.md "Hooks are an extensibility framework for Codex."
- DOC https://learn.chatgpt.com/docs/hooks.md "Codex discovers hooks next to active config layers in either of these forms:"
- DOC https://learn.chatgpt.com/docs/hooks.md "- `command` and `mcp_tool` handlers are supported. `prompt` and `agent`"
- DOC https://learn.chatgpt.com/docs/hooks.md "Set `async` to `true` to run a command hook in the"
- DOC https://learn.chatgpt.com/docs/hooks.md "You can also use exit code `2` and write the blocking reason to `stderr`."
- DOC https://learn.chatgpt.com/docs/hooks.md "Background hooks can't block, approve, rewrite, or otherwise control the"
- DOC https://learn.chatgpt.com/docs/hooks.md "`SessionEnd` hooks always run synchronously, even when `async` is `true`."
- DOC https://learn.chatgpt.com/docs/hooks.md "`additionalContext` to the model's context"
- DOC https://learn.chatgpt.com/docs/hooks.md "Hooks are enabled by default."

Configuration mechanism: `hooks.json` or inline `[hooks]` tables in
`config.toml`, discovered next to active config layers at
`~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`
and `<repo>/.codex/config.toml`. Only `command` and `mcp_tool` handlers are
executed; `prompt` and `agent` handlers are parsed and skipped. Command
hooks accept `async: true`, except that `SessionEnd` always runs
synchronously.

| Native event | Fires | Can block, and how | Handler types | Async | Context into next turn |
| --- | --- | --- | --- | --- | --- |
| SessionStart | Session or subagent starts | No | command, mcp | command async | append via `additionalContext` |
| UserPromptSubmit | Prompt about to be sent | Yes, exit 2 or `decision: "block"` | command, mcp | command async | append |
| PreToolUse | Before a supported tool call | Yes, exit 2, `permissionDecision: "deny"`, or `decision: "block"` | command, mcp | command async | append |
| PermissionRequest | Before Codex asks for approval | Yes, `decision.behavior: "deny"` | command, mcp | command async | none documented |
| PostToolUse | After a supported tool returns | No, tool already ran | command, mcp | command async | append |
| SubagentStart | Subagent starts | No | command, mcp | command async | append |
| SubagentStop | Subagent stops | Yes, `decision: "block"` asks it to continue | command, mcp | command async | none documented |
| Stop | Turn stops | Yes, `decision: "block"` asks for another pass | command, mcp | command async | none documented |
| PreCompact | Before compaction | Yes, `continue: false` stops before compacting | command, mcp | command async | none documented |
| PostCompact | After compaction | No, can only stop after the fact | command, mcp | command async | none documented |
| SessionEnd | Main thread ends | No | command only, MCP not supported | always synchronous | none |

There is no documented turn-start native event. `Interrupt` and
`PermissionRequest` are the remaining Codex events; `Interrupt` cannot
prevent the interruption.

### OpenCode

Sources:

- DOC https://opencode.ai/docs/plugins.md "Plugins allow you to extend OpenCode by hooking into various events and customizing behavior."
- DOC https://opencode.ai/docs/plugins.md "A plugin is a **JavaScript/TypeScript module** that exports one or more plugin"
- DOC https://opencode.ai/docs/plugins.md "tool.execute.before"
- DOC https://opencode.ai/docs/plugins.md "tool.execute.after"
- DOC https://opencode.ai/docs/plugins.md "permission.asked"
- DOC https://opencode.ai/docs/plugins.md "experimental.session.compacting"
- DOC https://opencode.ai/docs/plugins.md "Do not read .env files"
- DOC https://opencode.ai/docs/plugins.md "output.context.push"

Configuration mechanism: JS or TypeScript plugin files in
`.opencode/plugins/` or `~/.config/opencode/plugins/`, or npm package names
in the `plugin` array of `opencode.json`. A plugin function returns an object
of hook functions. The documented hooks include `tool.execute.before`,
`tool.execute.after`, `permission.asked`, `permission.replied`,
`session.created`, `session.compacted`, `session.deleted`, `session.idle`,
`session.error` and `experimental.session.compacting`. A `tool.execute.before`
plugin can block by throwing an Error. `experimental.session.compacting` can
append to the compaction prompt via `output.context`.

OpenCode therefore has native seams for `tool-call`, `tool-result`,
`permission-request`, `conversation-start`, `conversation-end`,
`compact-start` and maybe `turn-end`, but it does not support the AIP-71
handler enum (`command`, `mcp`, `http`, `prompt`, `agent`). Its handlers are
in-process plugin functions. No cell can be proposed without inventing a
handler type, so all OpenCode cells are `unavailable` for AIP-71 as written.

### Gemini CLI

Sources:

- DOC https://geminicli.com/docs/hooks/ "Hooks run synchronously as part of the agent loop"
- DOC https://geminicli.com/docs/hooks/ "The target action (tool, turn, or stop) is aborted."
- DOC https://geminicli.com/docs/hooks/ "Hooks are configured in"
- DOC https://geminicli.com/docs/hooks/ "Currently only"
- DOC https://geminicli.com/docs/hooks/ "The shell command to execute."
- DOC https://geminicli.com/docs/hooks/ "Block Tool / Rewrite"
- DOC https://geminicli.com/docs/hooks/ "Block Result / Context"
- DOC https://geminicli.com/docs/hooks/ "Inject Context"

Configuration mechanism: `settings.json` at project, user or system scope
(`.gemini/settings.json`, `~/.gemini/settings.json`,
`/etc/gemini-cli/settings.json`). Handler type is `command` only. Hooks run
synchronously. Exit code 2 is a system block; exit code 0 with JSON is the
preferred control path.

| Native event | Fires | Can block, and how | Handler types | Async | Context into next turn |
| --- | --- | --- | --- | --- | --- |
| SessionStart | Session begins | No | command | no | append |
| BeforeAgent | After prompt, before planning | Yes, block turn | command | no | append |
| BeforeTool | Before a tool executes | Yes, block tool or rewrite | command | no | none documented |
| AfterTool | After a tool executes | No, tool already ran; can block the result | command | no | append |
| AfterAgent | Agent loop ends | No, can halt or retry after the fact | command | no | none documented |
| PreCompress | Before context compression | No, advisory | command | no | none documented |
| SessionEnd | Session ends | No, advisory | command | no | none |

No `permission-request`, `compact-end`, `subagent-start`, `subagent-end` or
`turn-start` event is documented.

### GitHub Copilot CLI

Sources:

- DOC https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks "Hooks are a way of executing custom shell commands at strategic points in an agent's workflow"
- DOC https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks "Hooks run synchronously and block agent execution."
- DOC https://docs.github.com/en/copilot/reference/hooks-reference "Command hooks run shell scripts or executables and are supported on all hook types."
- DOC https://docs.github.com/en/copilot/reference/hooks-reference "Fires before the permission service runs"
- DOC https://docs.github.com/en/copilot/reference/hooks-reference "command and HTTP variants"
- DOC https://docs.github.com/en/copilot/reference/hooks-reference "can allow, deny, or modify"

Configuration mechanism: repository hooks in `.github/hooks/*.json` and
personal hooks in `~/.copilot/hooks/*.json`, with a top-level `version: 1`
and a `hooks` object. Handler types are `command` and `http`; `prompt` hooks
are supported only on `sessionStart`. Hooks run synchronously.

| Native event | Fires | Can block, and how | Handler types | Async | Context into next turn |
| --- | --- | --- | --- | --- | --- |
| sessionStart | New or resumed session | No, may inject context | command, http, prompt | no | append |
| userPromptSubmitted | User submits a prompt | No documented block | command, http | no | none documented |
| preToolUse | Before each tool executes | Yes, allow, deny or modify | command, http | no | none documented |
| permissionRequest | Before the permission service | Yes, `behavior: "allow"` or `"deny"` | command, http | no | none documented |
| postToolUse | After a tool succeeds | No, can modify result | command, http | no | append |
| postToolUseFailure | After a tool fails | No, can provide recovery context | command, http | no | append |
| subagentStart | Subagent spawned | No, cannot block creation | command, http | no | append |
| subagentStop | Subagent completes | Yes, block and force continuation | command, http | no | none documented |
| agentStop | Main agent finishes a turn | Yes, block and force continuation | command, http | no | none documented |
| preCompact | Before compaction | No, notification only | command, http | no | none documented |
| sessionEnd | Session terminates | No | command, http | no | none documented |

No Copilot `compact-end` or `turn-start` event is documented.

## Step 3: what this repo does today about hooks

No adapter in this repo writes a native harness hook file or passes native
hook configuration. The only hook engine in the repo is the daemon-side
`.agentproto/hooks.json` semantic engine, which is documented as a separate
surface:

- packages/runtime/src/hooks-config.ts:70 `const HOOKS_CONFIG_REL = ".agentproto/hooks.json"`
- packages/runtime/src/hooks-config.ts:256 `export function loadHooksConfig(workspace: string): HookRule[] {`

That engine is consulted at the ACP permission seam in
packages/runtime/src/sessions.ts:7767 `const hookRules = loadHooksConfig(workspace)`.
It is not projected into Claude Code, Codex, Gemini, Copilot or OpenCode
configuration.

Per adapter, the hook-adjacent behaviour today is:

| Adapter | Writes or passes hook or settings config today | Evidence |
| --- | --- | --- |
| claude-code | Writes an isolated `settings.json` containing attribution and optional `permissions.defaultMode`/`additionalDirectories`; no `hooks` key | packages/driver/agent-cli/src/define-agent-cli.ts:681 `const isolatedSettings: Record<string, unknown> = {`; packages/driver/agent-cli/src/define-agent-cli.ts:693 `isolatedSettings.permissions = isolatedPermissions`; packages/driver/agent-cli/src/define-agent-cli.ts:698 `writeFileSync(` |
| codex | Seeds `config.toml` with `project_root_markers = []` under `CODEX_HOME`; no `[hooks]` table | adapters/codex/src/index.ts:118 `stateHome: {`; adapters/codex/src/index.ts:124 `seed: { "config.toml": "project_root_markers = []\n" },` |
| opencode | Layers an inline `OPENCODE_CONFIG_CONTENT` permission block for posture; no OpenCode plugin or hook file | packages/driver/agent-cli/src/define-agent-cli.ts:521 `const opencodePermission =`; packages/driver/agent-cli/src/define-agent-cli.ts:524 `env.OPENCODE_CONFIG_CONTENT = mergeOpencodePermission(` |
| gemini | No hook configuration is written by the adapter | adapters/gemini/src/index.ts:43 `bin_args: ["--experimental-acp"],` (spawn is ACP only) |
| copilot-cli | No hook configuration is written by the adapter | adapters/copilot-cli/src/index.ts:48 `bin_args: ["--acp", "--stdio"],` |
| grok-cli | No hook configuration is written by the adapter | adapters/grok-cli/src/index.ts:60 `bin_args: ["agent", "stdio"],` |
| openclaw | No hook configuration is written by the adapter | adapters/openclaw/src/index.ts:39 `bin_args: ["acp"],` |
| hermes | No hook configuration is written by the adapter | adapters/hermes/src/index.ts:85 `bin_args: ["acp"],` |
| antigravity | No hook configuration is written by the adapter | adapters/antigravity/src/index.ts:58 `bin: "agy",` |
| jcode | No hook configuration is written by the adapter | adapters/jcode/src/index.ts:90 `bin_args: ["run"],` |
| mastracode | No hook configuration is written by the adapter | adapters/mastracode/src/index.ts:72 `bin_args: ["-y", "mastracode"],` |
| mastracode-inprocess | No hook configuration is written by the adapter | adapters/mastracode-inprocess/src/index.ts:47 `bin: "in-process",` |
| pi | No hook configuration is written by the adapter | adapters/pi/src/index.ts:116 `bin: "pi",` |
| claude-sdk | No hook configuration is written by the adapter | adapters/claude-sdk/src/index.ts:85 `bin_args: [cliEntry, "acp"],` |
| claude-code-cloud | No hook configuration is written by the adapter | adapters/claude-code-cloud/src/index.ts:64 `bin_args: [acpBin],` |
| mastra-agent | No hook configuration is written by the adapter | adapters/mastra-agent/src/index.ts:34 `bin_args: [cliEntry, "acp"],` |

### ACP permission request path

All ACP-arm adapters share one permission handler. The shared arm wires the
ACP `session/request_permission` callback here:

- packages/driver/agent-cli/src/protocol/acp-client.ts:259 `requestPermission: async params => permissionHandler(params),`

The per-adapter protocol declaration decides whether that path exists:

| Adapter | Protocol | Evidence | ACP permission request available |
| --- | --- | --- | --- |
| claude-code | acp | adapters/claude-code/src/index.ts:166 `protocol: "acp",` | yes |
| codex | acp | adapters/codex/src/index.ts:136 `protocol: "acp",` | yes |
| opencode | acp | adapters/opencode/src/index.ts:207 `protocol: "acp",` | yes |
| gemini | acp | adapters/gemini/src/index.ts:100 `protocol: "acp",` | yes |
| copilot-cli | acp | adapters/copilot-cli/src/index.ts:101 `protocol: "acp",` | yes |
| grok-cli | acp | adapters/grok-cli/src/index.ts:103 `protocol: "acp",` | yes |
| openclaw | acp | adapters/openclaw/src/index.ts:96 `protocol: "acp",` | yes |
| hermes | acp | adapters/hermes/src/index.ts:125 `protocol: "acp",` | yes |
| claude-sdk | acp | adapters/claude-sdk/src/index.ts:145 `protocol: "acp",` | yes |
| claude-code-cloud | acp | adapters/claude-code-cloud/src/index.ts:97 `protocol: "acp",` | yes |
| mastra-agent | acp | adapters/mastra-agent/src/index.ts:60 `protocol: "acp",` | yes |
| antigravity | print | adapters/antigravity/src/index.ts:88 `protocol: "print",` | no |
| jcode | print | adapters/jcode/src/index.ts:129 `protocol: "print",` | no |
| mastracode | print | adapters/mastracode/src/index.ts:136 `protocol: "print",` | no |
| pi | proprietary | adapters/pi/src/index.ts:180 `protocol: "proprietary",` | no |
| mastracode-inprocess | proprietary | adapters/mastracode-inprocess/src/index.ts:86 `protocol: "proprietary",` | no |

## Step 4: proposed capability matrix

Rows are the AIP-37 portable events requested in the task. Cells are the
proposed `NativeHookCapability` JSON only where the upstream documentation
supports every field. `unavailable` means the upstream harness has no
documented seam, or its seam cannot satisfy AIP-71, so the host must own
the binding. `NOT VERIFIED` is not used in this matrix because all listed
cells are backed by the evidence above, except where explicitly stated in
the NOT VERIFIED section.

For readability each cell uses the AIP-71 field order and short JSON. The
`handlers` names map `mcp_tool` to AIP-71 `mcp`, and `http` stays `http`.
None of these entries is installed by this document. AIP-71 says capability
declarations are metadata only:

- DOC https://raw.githubusercontent.com/agentproto/agentproto/main/specs/aip-71.mdx "interface NativeHookCapability"
- DOC https://raw.githubusercontent.com/agentproto/agentproto/main/specs/aip-71.mdx "Capability declarations are metadata."
- DOC https://raw.githubusercontent.com/agentproto/agentproto/main/specs/aip-71.mdx "capabilities.hooks"

| Portable event | claude-code | codex | opencode | gemini | copilot-cli |
| --- | --- | --- | --- | --- | --- |
| prompt-submit | `{event:"prompt-submit",native_event:"UserPromptSubmit",path:"admission",can_block:true,handlers:["command","mcp","http","prompt","agent"],async:true,context:"append"}` | `{event:"prompt-submit",native_event:"UserPromptSubmit",path:"admission",can_block:true,handlers:["command","mcp"],async:true,context:"append"}` | unavailable | `{event:"prompt-submit",native_event:"BeforeAgent",path:"admission",can_block:true,handlers:["command"],async:false,context:"append"}` | `{event:"prompt-submit",native_event:"userPromptSubmitted",path:"lifecycle",can_block:false,handlers:["command","http"],async:false,context:"none"}` |
| permission-request | `{event:"permission-request",native_event:"PermissionRequest",path:"admission",can_block:true,handlers:["command","mcp","http","prompt","agent"],async:true,context:"none"}` | `{event:"permission-request",native_event:"PermissionRequest",path:"admission",can_block:true,handlers:["command","mcp"],async:true,context:"none"}` | unavailable | unavailable | `{event:"permission-request",native_event:"permissionRequest",path:"admission",can_block:true,handlers:["command","http"],async:false,context:"none"}` |
| compact-start | `{event:"compact-start",native_event:"PreCompact",path:"admission",can_block:true,handlers:["command","mcp","http","prompt","agent"],async:true,context:"none"}` | `{event:"compact-start",native_event:"PreCompact",path:"admission",can_block:true,handlers:["command","mcp"],async:true,context:"none"}` | unavailable | `{event:"compact-start",native_event:"PreCompress",path:"lifecycle",can_block:false,handlers:["command"],async:false,context:"none"}` | `{event:"compact-start",native_event:"preCompact",path:"lifecycle",can_block:false,handlers:["command","http"],async:false,context:"none"}` |
| compact-end | `{event:"compact-end",native_event:"PostCompact",path:"lifecycle",can_block:false,handlers:["command","mcp","http","prompt","agent"],async:true,context:"none"}` | `{event:"compact-end",native_event:"PostCompact",path:"lifecycle",can_block:false,handlers:["command","mcp"],async:true,context:"none"}` | unavailable | unavailable | unavailable |
| subagent-start | `{event:"subagent-start",native_event:"SubagentStart",path:"lifecycle",can_block:false,handlers:["command","mcp","http","prompt","agent"],async:true,context:"append"}` | `{event:"subagent-start",native_event:"SubagentStart",path:"lifecycle",can_block:false,handlers:["command","mcp"],async:true,context:"append"}` | unavailable | unavailable | `{event:"subagent-start",native_event:"subagentStart",path:"lifecycle",can_block:false,handlers:["command","http"],async:false,context:"append"}` |
| subagent-end | `{event:"subagent-end",native_event:"SubagentStop",path:"admission",can_block:true,handlers:["command","mcp","http","prompt","agent"],async:true,context:"append"}` | `{event:"subagent-end",native_event:"SubagentStop",path:"admission",can_block:true,handlers:["command","mcp"],async:true,context:"none"}` | unavailable | unavailable | `{event:"subagent-end",native_event:"subagentStop",path:"admission",can_block:true,handlers:["command","http"],async:false,context:"none"}` |
| tool-call | `{event:"tool-call",native_event:"PreToolUse",path:"admission",can_block:true,handlers:["command","mcp","http","prompt","agent"],async:true,context:"append"}` | `{event:"tool-call",native_event:"PreToolUse",path:"admission",can_block:true,handlers:["command","mcp"],async:true,context:"append"}` | unavailable | `{event:"tool-call",native_event:"BeforeTool",path:"admission",can_block:true,handlers:["command"],async:false,context:"none"}` | `{event:"tool-call",native_event:"preToolUse",path:"admission",can_block:true,handlers:["command","http"],async:false,context:"none"}` |
| tool-result | `{event:"tool-result",native_event:"PostToolUse",path:"lifecycle",can_block:false,handlers:["command","mcp","http","prompt","agent"],async:true,context:"append"}` | `{event:"tool-result",native_event:"PostToolUse",path:"lifecycle",can_block:false,handlers:["command","mcp"],async:true,context:"append"}` | unavailable | `{event:"tool-result",native_event:"AfterTool",path:"lifecycle",can_block:false,handlers:["command"],async:false,context:"append"}` | `{event:"tool-result",native_event:"postToolUse",path:"lifecycle",can_block:false,handlers:["command","http"],async:false,context:"append"}` |
| turn-start | unavailable | unavailable | unavailable | unavailable | unavailable |
| turn-end | `{event:"turn-end",native_event:"Stop",path:"admission",can_block:true,handlers:["command","mcp","http","prompt","agent"],async:true,context:"append"}` | `{event:"turn-end",native_event:"Stop",path:"admission",can_block:true,handlers:["command","mcp"],async:true,context:"none"}` | unavailable | `{event:"turn-end",native_event:"AfterAgent",path:"lifecycle",can_block:false,handlers:["command"],async:false,context:"none"}` | `{event:"turn-end",native_event:"agentStop",path:"admission",can_block:true,handlers:["command","http"],async:false,context:"none"}` |
| conversation-start | `{event:"conversation-start",native_event:"SessionStart",path:"lifecycle",can_block:false,handlers:["command","mcp","http","prompt","agent"],async:true,context:"append"}` | `{event:"conversation-start",native_event:"SessionStart",path:"lifecycle",can_block:false,handlers:["command","mcp"],async:true,context:"append"}` | unavailable | `{event:"conversation-start",native_event:"SessionStart",path:"lifecycle",can_block:false,handlers:["command"],async:false,context:"append"}` | `{event:"conversation-start",native_event:"sessionStart",path:"lifecycle",can_block:false,handlers:["command","http","prompt"],async:false,context:"append"}` |
| conversation-end | `{event:"conversation-end",native_event:"SessionEnd",path:"lifecycle",can_block:false,handlers:["command","mcp","http","prompt","agent"],async:true,context:"none"}` | `{event:"conversation-end",native_event:"SessionEnd",path:"lifecycle",can_block:false,handlers:["command"],async:false,context:"none"}` | unavailable | `{event:"conversation-end",native_event:"SessionEnd",path:"lifecycle",can_block:false,handlers:["command"],async:false,context:"none"}` | `{event:"conversation-end",native_event:"sessionEnd",path:"lifecycle",can_block:false,handlers:["command","http"],async:false,context:"none"}` |

### Matrix notes

- OpenCode is `unavailable` across the matrix even where a native seam
  exists, because AIP-71 `handlers` does not include plugin functions.
- For Claude Code and Codex, `async: true` means command hooks can be
  backgrounded. A blocking admission binding must use a synchronous hook;
  AIP-71 already forbids silently downgrading a blocking binding to an
  observer.
- `context: "append"` is set only where the vendor documentation names an
  additional-context field or equivalent for that event.
- `turn-start` has no documented native event in any of the five upstream
  CLIs examined.
- Copilot CLI `prompt` handlers are only supported on `sessionStart`, which
  is why only that row lists `prompt`.
- A consumer MUST NOT treat a declaration with both `can_block: true` and
  `async: true` as an asynchronous blocking binding: a blocking admission
  binding must use the synchronous form.

### ACP permission request availability

| Adapter | ACP permission request |
| --- | --- |
| claude-code | yes |
| codex | yes |
| opencode | yes |
| gemini | yes |
| copilot-cli | yes |
| grok-cli | yes |
| openclaw | yes |
| hermes | yes |
| claude-sdk | yes |
| claude-code-cloud | yes |
| mastra-agent | yes |
| antigravity | no |
| jcode | no |
| mastracode | no |
| pi | no |
| mastracode-inprocess | no |

## Step 5: where `capabilities` is typed and where support is advertised

### Manifest schema and TypeScript type

The AIP-45 manifest is typed twice in this repo: a zod schema used by both
authoring paths, and a TypeScript interface.

- packages/driver/agent-cli/src/schema.ts:386 `const capabilitiesSchema = z.object({`
- packages/driver/agent-cli/src/schema.ts:426 `hooks: z`
- packages/driver/agent-cli/src/schema.ts:435 `}).strict()`
- packages/driver/agent-cli/src/types.ts:402 `export interface AgentCliCapabilities {`
- packages/driver/agent-cli/src/types.ts:459 `hooks?: readonly NativeHookCapability[]`
- packages/driver/agent-cli/src/schema.ts:640 `capabilities: capabilitiesSchema.optional(),`

`capabilitiesSchema` is strict and lists the known booleans (`streaming`,
`tool_calls`, `sub_agents`, `file_io`, `multimodal`, `resumable`,
`bidirectional`, `nativeTerminalResume`, `nativeToolSearch`,
`deferredToolDiscovery`, and the file-attach field) plus `hooks`. The
`hooks` key is an array of `nativeHookCapabilitySchema`, which mirrors the
AIP-71 `NativeHookCapability` shape:

- packages/driver/agent-cli/src/schema.ts:362 `const nativeHookHandlerSchema = z.enum(["command", "mcp", "http", "prompt", "agent"])`
- packages/driver/agent-cli/src/schema.ts:364 `const nativeHookCapabilitySchema = z`

Both authoring paths validate against this schema, and adapter handles read
the same shape through `AgentCliCapabilities.hooks`, so a declared `hooks`
array passes validation and is carried on the typed handle.

### Harness capability response

`harness_capabilities` is not built by a single runtime function. The MCP
tool delegates to an injected lister:

- packages/runtime/src/agent-tools.ts:2152 `"harness_capabilities",`
- packages/cli/src/registry/resolve.ts:1056 `export async function listHarnessCapabilities(opts?: {`
- packages/provider-kit/src/capability.ts:98 `export interface HarnessCapabilities {`
- packages/provider-kit/src/capability.ts:193 `export function deriveDeclaredCapabilities(def: HarnessManifestView): HarnessCapabilities {`

The `HarnessCapabilities` record has `adapter`, `source`, `discoverable`,
`authStores`, `providers`, `models`, `endpointCompat`, `application` and an
optional hook block:

- packages/provider-kit/src/capability.ts:114 `hooks?: readonly HookCapabilityView[]`

`deriveDeclaredCapabilities` reads the manifest field and projects it onto
that block:

- packages/provider-kit/src/capability.ts:211 `const declaredHooks = def.capabilities?.hooks`
- packages/provider-kit/src/capability.ts:230 `? { hooks: declaredHooks.map((hook) => ({ ...hook, handlers: [...hook.handlers] })) }`

### Session capability response

`session_capabilities` is built by one shared function used by both the MCP
tool and the HTTP twin:

- packages/runtime/src/session-capabilities.ts:141 `export function buildSessionCapabilities(`
- packages/runtime/src/session-tools.ts:2510 `"session_capabilities",`

The `SessionCapabilities` body has an optional hook block:

- packages/runtime/src/session-capabilities.ts:101 `hooks?: { native: readonly HookCapabilityView[] }`

`buildSessionCapabilities` emits it when the session descriptor carries
native hook declarations:

- packages/runtime/src/session-capabilities.ts:185 `...(desc.nativeHooks !== undefined && desc.nativeHooks.length > 0`
- packages/runtime/src/session-capabilities.ts:186 `? { hooks: { native: desc.nativeHooks } }`

The lifecycle package names these two surfaces as the only advertised homes
for hook capability discovery:

- packages/lifecycle/src/hooks.ts:41 `export const HOOK_CAPABILITY_SURFACES = [`
- packages/lifecycle/src/hooks.ts:42 `"harness_capabilities",`

## NOT VERIFIED

- AIP-71's final field optionality and any validator behaviour beyond the
  quoted `NativeHookCapability` interface.
- Grok CLI native hooks: no official hook documentation fetched.
- OpenClaw native hooks: no official hook documentation fetched.
- Hermes Agent native hooks: no official hook documentation fetched.
- Antigravity native hooks: no official hook documentation fetched.
- jcode native hooks: no official hook documentation fetched.
- Mastra Code native hooks: no official hook documentation fetched.
- pi native hooks: no official hook documentation fetched.
- Claude Code `PostToolUseFailure`, `Notification`, `PostToolBatch`,
  `PermissionDenied`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`,
  `ElicitationResult`, `WorktreeCreate`, `WorktreeRemove`, `TaskCreated`,
  `TaskCompleted` and `TeammateIdle`: not mapped because they are outside
  the requested portable rows.
- Codex `SubagentStart` and `PostCompact` context injection: the docs
  support common output fields but do not name `additionalContext` for
  those exact events, so the matrix uses `context: "none"` where not named.
- Copilot `preToolUse` and `postToolUse` context append semantics beyond the
  documented additional-context mentions: the matrix is conservative.
- Whether Claude Code's `SessionEnd` MCP tool hooks work in every runtime
  surface. The handler type is documented generally, but this pass did not
  verify MCP availability at session teardown.
- Whether a `hooks` array in `capabilities` would be accepted by the JSON
  Schema resource outside this repo. Only the in-repo zod schema and
  TypeScript interface were checked.
- The exact upstream CLI versions installed in production for gemini and
  copilot-cli. The documentation was read at the pinned commit date, not
  matched to a manifest version pin.
