# agentproto — multi-agent orchestration pack

Bundles the skills for operating and supervising **fleets of coding agents**
through the **agentproto** daemon, so they travel together as one installable pack.

## What's inside

| Skill | Triggers on | What it gives you |
|-------|-------------|-------------------|
| **agent-session-orchestration-agentproto** | "launch an agent / claude code / hermes", "supervise an agent", "resume/continue a session", "export a session", "see where an agent stopped", "babysit an agent" | The methodology + concrete `mcp__agentproto__*` commands: launch-and-leave, babysit step-by-step, read where a session stopped without paying a resume, export to readable markdown, resume with full context. |
| **light-coder-orchestration** | "make a cheap model code a task", "test glm / deepseek on real code", "run several agents in parallel on work packages", task → light-model execution → verify | Branch/select light models (glm, deepseek, kimi, qwen, grok via hermes/OpenRouter, or claude-code) with a **systematic Sonnet verification net**: bounded brief → execution → green gate → Sonnet verify → commit. Cautious parallelism + commit discipline. |
| **hermes-headless-background** | "lance un agent hermes/glm/deepseek en background", "fais auditer ça par un modèle pas cher pendant qu'on continue", or `mcp__agentproto__*` tools absent from the session | The **CLI-direct fallback** (no daemon, no MCP): run a hermes session on a cheap OpenRouter model (glm-5.2 / deepseek) headless in the background via the `hermes` binary, for delegable read-only audit / research / grunt-work. Model-verify via `state.db`, mandatory self-verification net (re-check every cited `file:line`) before relaying. Complements `agent-session-orchestration-agentproto`, which assumes the daemon. |
| **nested-orchestration** | "an agent that drives other agents", "nested orchestration", "a parent that launches several sub-agents then fans-in", "an agent babysitting another agent" | Orchestrating an **orchestrator**: a parent (claude-code, `orchestrator:true`) spawns + supervises its own sub-agents via a scoped gateway. Golden rule (proven): parent must be claude-code; hermes ignores the injected gateway. Fan-out/fan-in, babysit, scoped tool subset, isolation by scope-token. |
| **durable-supervision** | "a green gate as a commit condition", "attach a policy to an agent", "auto-commit when tests pass", "escalate to a human only when blocked", RoutineRunner / webhook notifyUrl / judge-gate | The in-daemon **governance layer**: `attach_policy` with a shell/judge gate at turn-end → `policy:passed/failed` on the event bus; gated host commit with human ack (`commit-ready → ack → committed`); per-session `notifyUrl` webhook escalation; RoutineRunner. |
| **adapter-setup-kit** | "which adapters/agents are installed", "configure cloudflare-named / a tunnel provider", "expose my local port in HTTPS", "a stable public URL for a remote agent" | The upstream of orchestration via `@agentproto/adapter-kit`: catalog adapters (agents / tunnels / browsers) with ready/available/supported status, configure credential-bearing providers (multi-field, stored 0600, never echoed), open public HTTPS tunnels (Cloudflare quick / named). |
| **supervisor-session** | "superviser au maximum en gardant la capacité d'agir", "faire construire un livrable multi-WP par des modèles pas chers", "industrialiser scout→brief→exécution→vérif→commit" | The **supervisor operational loop**: scout recon → SPEC + frozen interfaces → WP briefs → parallel executors (cheap models) → systematic disk verify → single-writer consolidation → adversarial verify + e2e live → draft PR. Proven pipeline (VS Code extension, 2026-07-14). |
| **agentproto-llm-endpoint** | "use my own LLM endpoint", "spawn Claude Code with Moonshot/OpenRouter/Groq", "custom Anthropic-compatible gateway" | The local LLM endpoint proxy (localhost:18090) and public https://llm-endpoint.clipgen.co/: route Claude Code / Claude SDK through custom providers (OpenRouter, Moonshot, Groq, ZAI, xAI) via Anthropic-compatible gateway. Covers adapter-specific behaviors, auth patterns, proxy codenames, and common failure modes. |
| **agentproto** | "operate agentproto", "build on agentproto", "author tools/drivers in agentproto" | The AIP open-standard agent protocol and its `agentproto` CLI + daemon: run/serve sessions, drive imported MCP tools, or author tools/drivers (defineTool → implementTool → defineDriver, projected to cli/http/mcp/sdk/mastra/ai-sdk). |

## How it works

All skills drive the agentproto MCP tools (`mcp__agentproto__*`). The orchestrator
(you, in Cowork) **does not code** — it slices work into bounded steps, launches and
supervises agents, reviews each diff, and gives the next step. The agents do the work.

Layering:

- **adapter-setup-kit** is the upstream (get an adapter / tunnel `ready`).
- **agent-session-orchestration** + **light-coder-orchestration** are flat orchestration
  (you, in Cowork, drive the agents).
- **hermes-headless-background** is the CLI-direct fallback for when the daemon /
  `mcp__agentproto__*` tools aren't loaded — same delegate-to-a-cheap-model idea,
  minus the daemon and MCP.
- **nested-orchestration** adds a tier (delegate the orchestration itself to a parent agent).
- **durable-supervision** adds the governance layer (policies, gated commits, webhook escalation)
  that survives without Cowork open.
- **supervisor-session** is the full supervisor pipeline when you want to industrialize
  multi-work-package builds with cheap-model executors and Sonnet verification.
- **agentproto-llm-endpoint** + **agentproto** are the infrastructure skills for custom
  providers and protocol authoring.

Load order: when doing any orchestration work, load the relevant skills first.

## Changelog

- **0.4.0** — add `supervisor-session` (proven supervisor pipeline), `agentproto-llm-endpoint`
  (custom provider gateway skill), and `agentproto` (protocol authoring skill). 9 skills total.
- **0.3.0** — add `hermes-headless-background` (CLI-direct hermes fallback, no
  daemon). Refresh `agent-session-orchestration-agentproto` (`wait_for_any` →
  `session_monitor` rename + supervision patterns 7-9) and `durable-supervision`
  (dedicated-worktree gate caveat). 6 skills total.
- **0.2.0** — add `nested-orchestration`, `durable-supervision`, `adapter-setup-kit`
  (all proven live 2026-06-25). 5 skills total.
- **0.1.0** — initial pack: `agent-session-orchestration-agentproto`,
  `light-coder-orchestration`.
