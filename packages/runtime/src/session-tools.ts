/**
 * MCP tools that expose the sessions registry to agents connected to
 * the daemon. Lets a remote operator (Mastra agent in cloud Guilde,
 * Claude Code as a sub-agent, …) spawn + drive agent CLIs on the
 * user's machine through the same MCP connection they already use
 * for fs/exec.
 *
 * Five tools:
 *   start_agent_session   spawn a long-running agent (claude / hermes / …)
 *   prompt_agent_session  send a follow-up turn to a live session
 *   list_agent_sessions   browse alive + recent sessions
 *   get_agent_session_output   tail the ring buffer
 *   kill_agent_session    SIGTERM the session
 *
 * Auth: same as every other daemon tool — gated by the gateway's
 * auth source (loopback bypass when no tunnel is up).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionsRegistry } from "./sessions.js"
import type {
  AgentAdapterResolver,
  AgentAdapterLister,
} from "./http-server.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  getActiveWorkspace,
} from "./workspaces-config.js"
import { discoverMcps } from "./mcp-discovery.js"
import {
  loadImportedMcps,
  saveImportedMcps,
  addImport,
  removeImport,
} from "./mcp-imports.js"
import type { McpProxyRegistry } from "./mcp-proxy.js"

/** Strip CSI/SGR ANSI escape sequences. Exported for test access. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

interface RegisterSessionToolsOptions {
  registry: SessionsRegistry
  /** Optional adapter resolver — required for `start_agent_session`
   *  (the others work with raw spawn sessions too). When unset the
   *  start tool returns a clear error pointing at the host wiring. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Optional adapter lister — when wired, exposes `list_adapters`
   *  MCP tool. Without it the tool returns a clear "not configured"
   *  error pointing at the host wiring. */
  listAgentAdapters?: AgentAdapterLister
  /** Optional MCP proxy registry — when wired, exposes 3 tools that
   *  let the operator drive imported MCPs (chrome-devtools, goose-bridge,
   *  …) through the daemon as a single MCP entry point. */
  mcpProxy?: McpProxyRegistry
  /** Whether the registry was constructed with a PTY factory — when
   *  true, expose the four terminal session tools. When false, the
   *  tools return a clear "not configured" error. */
  ptyEnabled?: boolean
}

export function registerSessionTools(
  server: McpServer,
  opts: RegisterSessionToolsOptions
): void {
  const { registry, resolveAgentAdapter, listAgentAdapters, mcpProxy } = opts
  const ptyEnabled = opts.ptyEnabled === true

  // ── start_agent_session ────────────────────────────────────────
  server.tool(
    "start_agent_session",
    "Spawn a long-running agent CLI (claude-code, hermes, …) on the host. " +
      "The session stays alive across multiple turns — call `prompt_agent_session` " +
      "to continue the conversation. Returns the session id + initial descriptor. " +
      "When `workspaceSlug` is set, resolves the cwd via " +
      "`~/.agentproto/workspaces.json`; otherwise pass `cwd` explicitly or " +
      "fall back to the active workspace.",
    {
      adapter: z
        .string()
        .min(1)
        .describe(
          "Adapter slug — one of the installed `@agentproto/adapter-*` packages " +
            "(e.g. 'claude-code', 'hermes', 'aider')."
        ),
      workspaceSlug: z
        .string()
        .optional()
        .describe(
          "Workspace slug from `agentproto workspace list`. The daemon resolves it " +
            "to an absolute path. Omit to use the `cwd` field or the active workspace."
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute path to spawn the agent in. Wins over `workspaceSlug` when both are set."
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          "Optional initial prompt. The session is spawned and the prompt dispatched " +
            "in one shot — equivalent to `start` then `prompt` back-to-back. Skip to spawn idle."
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Free-text label that surfaces in `list_agent_sessions` and the UI — useful " +
            "for tagging sessions with a conversation id or operator name."
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Model identifier to pass to the adapter (e.g. 'claude-opus-4-8'). " +
            "Adapters that expose a `--model` flag honour this; others ignore it."
        ),
      mcpServers: z
        .array(
          z.object({
            name: z.string(),
            transport: z.enum(["stdio", "http", "sse"]),
            ref: z.string().optional(),
          })
        )
        .optional()
        .describe(
          "MCP servers to mount into the spawned agent's session at spawn time. " +
            "Forwarded verbatim to `session/new.mcpServers` on the ACP arm — gives " +
            "the child agent a host-chosen scoped toolset (e.g. the daemon's own " +
            "orchestration gateway so it can spawn + supervise sub-agents). " +
            "Adapters that don't model MCP mounting ignore it."
        ),
    },
    async input => {
      if (!resolveAgentAdapter) {
        return {
          content: [
            {
              type: "text",
              text:
                "start_agent_session is not enabled — the daemon was started without " +
                "an adapter resolver. Re-run the daemon with the `@agentproto/cli` " +
                "shim wired (see playground/scripts/gateway.ts).",
            },
          ],
          isError: true,
        }
      }
      // cwd resolution mirrors the HTTP route: explicit cwd wins,
      // then workspaceSlug lookup, then active workspace, then a
      // hard error (the operator probably forgot a step).
      let cwd = input.cwd
      let resolvedSlug = input.workspaceSlug ?? "default"
      if (!cwd) {
        try {
          const config = await loadWorkspacesConfig()
          const ws = input.workspaceSlug
            ? findWorkspace(config, input.workspaceSlug)
            : getActiveWorkspace(config)
          if (ws) {
            cwd = ws.path
            resolvedSlug = ws.slug
          }
        } catch {
          // fall through to error below
        }
      }
      if (!cwd) {
        return {
          content: [
            {
              type: "text",
              text:
                "start_agent_session: no cwd resolvable. Pass `cwd` explicitly, " +
                "or pass `workspaceSlug` matching `agentproto workspace list`, " +
                "or set an active workspace via `agentproto workspace use <slug>`.",
            },
          ],
          isError: true,
        }
      }
      const resolved = await resolveAgentAdapter(input.adapter)
      if (!resolved) {
        return {
          content: [
            {
              type: "text",
              text: `start_agent_session: adapter "${input.adapter}" not found. Try \`agentproto install <slug>\` first.`,
            },
          ],
          isError: true,
        }
      }
      try {
        const agentSession = await resolved.startSession({
          cwd,
          ...(input.model ? { model: input.model } : {}),
          ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        })
        const desc = registry.spawnAgent({
          workspaceSlug: resolvedSlug,
          cwd,
          agentSession,
          adapterSlug: input.adapter,
          ...(input.prompt ? { initialPrompt: input.prompt } : {}),
          ...(input.label ? { label: input.label } : {}),
          ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
          ...(resolved.commandPreview
            ? { commandPreview: resolved.commandPreview }
            : {}),
        })
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `start_agent_session: spawn failed — ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── prompt_agent_session ───────────────────────────────────────
  server.tool(
    "prompt_agent_session",
    "Send a follow-up prompt to a live agent session — multi-turn continuity " +
      "without re-spawning. The session id comes from `start_agent_session` " +
      "(or `list_agent_sessions`). Returns immediately; tail output via " +
      "`get_agent_session_output` or the SSE /sessions/:id/stream endpoint.",
    {
      sessionId: z.string().describe("Session id returned by start_agent_session."),
      prompt: z.string().min(1).describe("The next user turn (plain text)."),
    },
    async input => {
      try {
        // Note: sendPrompt awaits the full turn (drains the event
        // stream into the ring buffer). For long turns the operator
        // would prefer fire-and-forget — kick the promise without
        // awaiting and report "queued". The caller polls
        // get_agent_session_output for completion.
        void registry.sendPrompt(input.sessionId, input.prompt).catch(() => {
          // Errors land in the ring buffer; nothing to do here.
        })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, sessionId: input.sessionId, queued: true },
                null,
                2
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `prompt_agent_session: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── list_sessions (canonical lister) ──────────────────────────
  server.tool(
    "list_sessions",
    "List sessions tracked by the daemon — agent-CLI sessions (claude-code, " +
      "hermes, …), terminal/PTY sessions (claude TUI, bash, …), and raw " +
      "commands. Each entry includes `kind`, `pty` (true for real PTYs), " +
      "`name` (when set at spawn), `status`, `command`, age + exit code. Use " +
      "this when you need to know what's already running before spawning " +
      "anything new, or to discover a session id by name.",
    {
      kind: z
        .enum(["terminal", "agent-cli", "command", "all"])
        .optional()
        .describe(
          "Filter by session kind. `all` (default) returns every kind. " +
            "Use `terminal` to list only PTY sessions, `agent-cli` for " +
            "structured ACP agents.",
        ),
      onlyAlive: z
        .boolean()
        .optional()
        .describe("When true, only running/starting sessions. Default false."),
      status: z
        .enum(["starting", "running", "exited", "killed", "error"])
        .optional()
        .describe("Filter by exact status (overrides onlyAlive)."),
    },
    async input => {
      let rows = registry.list()
      if (input.kind && input.kind !== "all") {
        rows = rows.filter(s => s.kind === input.kind)
      }
      if (input.status) {
        rows = rows.filter(s => s.status === input.status)
      } else if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ sessions: rows }, null, 2) },
        ],
      }
    },
  )

  // ── list_agent_sessions (kept for backwards compatibility) ─────
  server.tool(
    "list_agent_sessions",
    "DEPRECATED — prefer `list_sessions` which returns ALL kinds + filters. " +
      "Despite the name this tool already returns every kind, not just " +
      "agent-cli sessions; the new tool's name reflects the actual surface.",
    {
      onlyAlive: z
        .boolean()
        .optional()
        .describe("Filter to status running/starting only. Default false."),
    },
    async input => {
      const all = registry.list()
      const filtered = input.onlyAlive
        ? all.filter(s => s.status === "running" || s.status === "starting")
        : all
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sessions: filtered }, null, 2),
          },
        ],
      }
    }
  )

  // ── get_agent_session_output ───────────────────────────────────
  server.tool(
    "get_agent_session_output",
    "Tail the recent output of a session. Returns the last N lines of the " +
      "ring buffer (stdout + stderr inter-leaved, newest last). Use this to read " +
      "an agent's reply after `prompt_agent_session`.",
    {
      sessionId: z.string().describe("Session id."),
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max lines to return. Default 80, max 500."),
    },
    async input => {
      const desc = registry.get(input.sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text", text: `get_agent_session_output: no session "${input.sessionId}"` },
          ],
          isError: true,
        }
      }
      // Best-effort tail — re-attach with a temp listener, capture
      // backfill (which is the recent ring buffer), unsubscribe.
      const limit = input.lastN ?? 80
      const lines: string[] = []
      const unsub = registry.attach(input.sessionId, (line, _stream) => {
        lines.push(line)
      })
      if (unsub) unsub()
      const tail = lines.slice(-limit)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId: input.sessionId,
                status: desc.status,
                lastOutputAt: desc.lastOutputAt,
                lines: tail,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  // ── list_adapters ──────────────────────────────────────────────
  server.tool(
    "list_adapters",
    "Enumerate every agent CLI adapter installed on the host (claude-code, " +
      "hermes, aider, …). Returns slug + display name + version + protocol so " +
      "callers can let users pick from the installed set instead of guessing. " +
      "Use before `start_agent_session` when the model doesn't already know " +
      "what's available.",
    {},
    async () => {
      if (!listAgentAdapters) {
        return {
          content: [
            {
              type: "text",
              text:
                "list_adapters is not enabled — the daemon was started without " +
                "an adapter lister. Wire `@agentproto/cli`'s " +
                "`listInstalledAdapters` via `createGateway({ listAgentAdapters })`.",
            },
          ],
          isError: true,
        }
      }
      try {
        const adapters = await listAgentAdapters()
        return {
          content: [{ type: "text", text: JSON.stringify({ adapters }, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `list_adapters failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── list_discovered_mcps ───────────────────────────────────────
  server.tool(
    "list_discovered_mcps",
    "Discover MCP servers already configured in the user's other agent " +
      "tooling (claude-code, cursor, goose). Returns the union with source " +
      "attribution so the operator can suggest 'I see you have a chrome-devtools " +
      "MCP set up in claude — want me to use it?' instead of asking the user " +
      "to re-configure. Read-only — does not modify any host's config.",
    {},
    async () => {
      try {
        const mcps = await discoverMcps()
        return {
          content: [{ type: "text", text: JSON.stringify({ mcps }, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `list_discovered_mcps failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── list_imported_mcps ─────────────────────────────────────────
  server.tool(
    "list_imported_mcps",
    "Return the user's curated set of MCP servers — the ones they've " +
      "imported from claude / cursor / workspace configs into the daemon. " +
      "Use to know which MCPs the operator may freely call vs. ones still " +
      "showing up in `list_discovered_mcps` waiting on the user's blessing.",
    {},
    async () => {
      try {
        const config = await loadImportedMcps()
        return {
          content: [
            { type: "text", text: JSON.stringify(config, null, 2) },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `list_imported_mcps failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── import_mcp ─────────────────────────────────────────────────
  server.tool(
    "import_mcp",
    "Import a discovered MCP into the daemon's curated set. The agent " +
      "calls `list_discovered_mcps` first, asks the user, then commits the " +
      "choice via this tool. The snapshot is captured at import time so " +
      "the entry stays usable if the source config (claude/cursor) is " +
      "later removed.",
    {
      sourceMcpId: z
        .string()
        .min(1)
        .describe(
          "The discovered MCP id from `list_discovered_mcps` " +
            "(e.g. 'claude-code:project:/path:chrome-devtools')."
        ),
      alias: z
        .string()
        .optional()
        .describe(
          "Optional friendly name to display. Defaults to the source MCP's name."
        ),
    },
    async input => {
      try {
        const discovered = await discoverMcps()
        const snapshot = discovered.find(d => d.id === input.sourceMcpId)
        if (!snapshot) {
          return {
            content: [
              {
                type: "text",
                text: `import_mcp: discovered MCP "${input.sourceMcpId}" not found. Re-run list_discovered_mcps to get current ids.`,
              },
            ],
            isError: true,
          }
        }
        const cfg = await loadImportedMcps()
        const next = addImport(cfg, {
          snapshot,
          ...(input.alias ? { alias: input.alias } : {}),
        })
        await saveImportedMcps(next)
        const entry = next.imports.find(e => e.id === snapshot.id)
        return {
          content: [{ type: "text", text: JSON.stringify(entry, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `import_mcp failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── remove_imported_mcp ────────────────────────────────────────
  server.tool(
    "remove_imported_mcp",
    "Remove a previously-imported MCP from the daemon's curated set. " +
      "Use when the user no longer wants the operator referencing it.",
    {
      id: z
        .string()
        .min(1)
        .describe(
          "The imported MCP id (matches the discovered MCP id at import time)."
        ),
    },
    async input => {
      try {
        const cfg = await loadImportedMcps()
        if (!cfg.imports.some(e => e.id === input.id)) {
          return {
            content: [
              {
                type: "text",
                text: `remove_imported_mcp: id "${input.id}" not in imports. Use list_imported_mcps to see current entries.`,
              },
            ],
            isError: true,
          }
        }
        await saveImportedMcps(removeImport(cfg, input.id))
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, id: input.id }, null, 2) },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `remove_imported_mcp failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── mcp_imported_status ────────────────────────────────────────
  // The 3 proxy tools share the same wiring guard — register them
  // only when the host injected a proxy registry, otherwise emit a
  // clear "not enabled" error so the agent doesn't think the daemon
  // silently dropped the call.
  server.tool(
    "mcp_imported_status",
    "Snapshot every imported MCP server with its connection status, " +
      "transport type, and tool count. Use this first when an operator " +
      "wonders 'what MCPs do I actually have access to right now?' — the " +
      "answer covers both 'imported but not yet connected' and 'connected " +
      "with N tools'. Errors during connect surface in `lastError`.",
    {},
    async () => {
      if (!mcpProxy) {
        return {
          content: [
            {
              type: "text",
              text:
                "mcp_imported_status is not enabled — daemon was started without " +
                "an MCP proxy. The host must wire `mcpProxy` in createGateway.",
            },
          ],
          isError: true,
        }
      }
      try {
        const aliases = await mcpProxy.listAliases()
        return {
          content: [
            { type: "text", text: JSON.stringify({ imports: aliases }, null, 2) },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_imported_status failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── mcp_imported_list_tools ────────────────────────────────────
  server.tool(
    "mcp_imported_list_tools",
    "List the tools exposed by one imported MCP server. The proxy " +
      "lazily connects on first call — first-use latency includes the " +
      "transport handshake (stdio: ~1-2s for npx-spawned servers; " +
      "http/sse: <100ms). Returns the upstream `inputSchema` (JSON " +
      "Schema) verbatim so the operator can build a valid `arguments` " +
      "object for the follow-up `mcp_imported_call` invocation.",
    {
      alias: z
        .string()
        .min(1)
        .describe(
          "Alias from `list_imported_mcps` / `mcp_imported_status` " +
            "(typically the original MCP name, e.g. 'chrome-devtools')."
        ),
    },
    async input => {
      if (!mcpProxy) {
        return {
          content: [
            {
              type: "text",
              text: "mcp_imported_list_tools is not enabled — see mcp_imported_status.",
            },
          ],
          isError: true,
        }
      }
      const out = await mcpProxy.listTools(input.alias)
      if (!out.ok) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_imported_list_tools "${input.alias}": ${out.error}`,
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ alias: input.alias, tools: out.tools }, null, 2) },
        ],
      }
    }
  )

  // ── mcp_imported_call ──────────────────────────────────────────
  server.tool(
    "mcp_imported_call",
    "Invoke a tool on an imported MCP server. The daemon proxies the " +
      "call through the live client connection — the upstream server " +
      "validates `arguments` against its own input schema (which you " +
      "can fetch via `mcp_imported_list_tools`). The full upstream " +
      "result is returned verbatim, including `isError` flags so the " +
      "operator sees the original failure shape.",
    {
      alias: z.string().min(1).describe("Imported MCP alias."),
      toolName: z
        .string()
        .min(1)
        .describe(
          "Tool name as it appears in `mcp_imported_list_tools` " +
            "(NOT a namespaced version — pass the upstream's own name)."
        ),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Tool arguments as a JSON object. Schema is the upstream's " +
            "— the proxy doesn't validate, only forwards. Default: empty object."
        ),
    },
    async input => {
      if (!mcpProxy) {
        return {
          content: [
            {
              type: "text",
              text: "mcp_imported_call is not enabled — see mcp_imported_status.",
            },
          ],
          isError: true,
        }
      }
      const out = await mcpProxy.callTool(
        input.alias,
        input.toolName,
        input.args ?? {}
      )
      if (!out.ok) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_imported_call "${input.alias}".${input.toolName}: ${out.error}`,
            },
          ],
          isError: true,
        }
      }
      // Forward the upstream result. The MCP SDK's CallToolResult is
      // already in the {content, isError?} shape we return — pass it
      // through with a note that it came from the proxy.
      return out.result as {
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }
    }
  )

  // ── kill_agent_session ─────────────────────────────────────────
  server.tool(
    "kill_agent_session",
    "Stop a session — SIGTERM the underlying child + close the agent protocol " +
      "session. Use to free resources after the operator is done, or when a " +
      "session is wedged.",
    {
      sessionId: z.string().describe("Session id."),
    },
    async input => {
      const ok = registry.kill(input.sessionId)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId: input.sessionId }, null, 2),
          },
        ],
      }
    }
  )

  // ── Terminal session tools ─────────────────────────────────────
  // Four tools that mirror the agent-session set but operate on raw
  // PTY sessions (real terminal, ANSI bytes, multi-subscriber). Use
  // these to drive interactive CLIs like `claude` in TUI mode, or
  // for one agent to orchestrate other shells. Read/write/exit
  // happen over the byte ring buffer; the WS at /sessions/:id/pty
  // is the streaming alternative.

  const ptyNotConfigured = (toolName: string): {
    content: Array<{ type: "text"; text: string }>
    isError: true
  } => ({
    content: [
      {
        type: "text",
        text:
          `${toolName}: PTY support not enabled — the daemon was started without ` +
          "a node-pty factory. Re-run `agentproto serve` from a build that ships " +
          "node-pty (the optional dep ships with @agentproto/cli).",
      },
    ],
    isError: true,
  })

  server.tool(
    "start_terminal_session",
    "Spawn a process under a real PTY (node-pty) on the host. Bytes (including " +
      "ANSI escapes, alt-screen sequences) flow through the daemon's byte ring " +
      "buffer; subscribers attach via the WS at /sessions/:id/pty. Use for " +
      "interactive TUIs (claude, vim, htop) or to orchestrate shells from another " +
      "agent. Returns the session descriptor.",
    {
      argv: z
        .array(z.string())
        .min(1)
        .describe(
          "Argv array. First element is the binary, rest are arguments. " +
            "e.g. ['claude'] or ['bash', '-l']."
        ),
      workspaceSlug: z
        .string()
        .optional()
        .describe(
          "Workspace slug from `agentproto workspace list`. Resolves cwd. Omit " +
            "to use `cwd` explicitly or the active workspace."
        ),
      cwd: z
        .string()
        .optional()
        .describe("Absolute cwd. Wins over workspaceSlug when both set."),
      cols: z.number().int().min(1).max(500).optional().describe("Initial cols. Default 80."),
      rows: z.number().int().min(1).max(200).optional().describe("Initial rows. Default 24."),
      name: z
        .string()
        .optional()
        .describe(
          "User-friendly slug. Becomes an alias for the session id in " +
            "subsequent tool calls (read/write/kill accept either)."
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Free-text label surfaced in list_agent_sessions and the UI."
        ),
    },
    async input => {
      if (!ptyEnabled) return ptyNotConfigured("start_terminal_session")
      let cwd = input.cwd
      let resolvedSlug = input.workspaceSlug ?? "default"
      if (!cwd) {
        try {
          const config = await loadWorkspacesConfig()
          const ws = input.workspaceSlug
            ? findWorkspace(config, input.workspaceSlug)
            : getActiveWorkspace(config)
          if (ws) {
            cwd = ws.path
            resolvedSlug = ws.slug
          }
        } catch {
          // fall through to error
        }
      }
      if (!cwd) {
        return {
          content: [
            {
              type: "text",
              text:
                "start_terminal_session: no cwd resolvable. Pass `cwd` explicitly " +
                "or `workspaceSlug` matching `agentproto workspace list`.",
            },
          ],
          isError: true,
        }
      }
      try {
        const desc = registry.spawnPty({
          argv: input.argv,
          cwd,
          workspaceSlug: resolvedSlug,
          cols: input.cols ?? 80,
          rows: input.rows ?? 24,
          ...(input.name ? { name: input.name } : {}),
          ...(input.label ? { label: input.label } : {}),
        })
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `start_terminal_session: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  server.tool(
    "write_terminal_input",
    "Send keystrokes to a PTY session's stdin. The text is forwarded verbatim — " +
      "include trailing newlines if the target needs them (e.g. shell commands). " +
      "Use after `start_terminal_session` to drive an interactive CLI.",
    {
      sessionId: z
        .string()
        .describe("Session id OR name from start_terminal_session."),
      text: z.string().describe("Text to write. Sent as-is to the PTY's stdin."),
    },
    async input => {
      if (!ptyEnabled) return ptyNotConfigured("write_terminal_input")
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            {
              type: "text",
              text: `write_terminal_input: no session "${input.sessionId}"`,
            },
          ],
          isError: true,
        }
      }
      const ok = registry.writeTerminalInput(desc.id, input.text)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId: desc.id }, null, 2),
          },
        ],
        ...(ok ? {} : { isError: true as const }),
      }
    }
  )

  server.tool(
    "read_terminal_output",
    "Snapshot the recent byte buffer of a PTY session. Returns base64-encoded " +
      "bytes (the buffer is RAW including ANSI escapes — strip with a regex if " +
      "you want plain text). `lastBytes` caps the read from the tail.",
    {
      sessionId: z
        .string()
        .describe("Session id OR name from start_terminal_session."),
      lastBytes: z
        .number()
        .int()
        .min(1)
        .max(64 * 1024)
        .optional()
        .describe("Max bytes from the tail. Default: full ring buffer (~64 KiB)."),
    },
    async input => {
      if (!ptyEnabled) return ptyNotConfigured("read_terminal_output")
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            {
              type: "text",
              text: `read_terminal_output: no session "${input.sessionId}"`,
            },
          ],
          isError: true,
        }
      }
      const buf = registry.readTerminalOutput(
        desc.id,
        input.lastBytes,
      )
      if (!buf) {
        return {
          content: [
            {
              type: "text",
              text: `read_terminal_output: session "${desc.id}" is not a PTY`,
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId: desc.id,
                status: desc.status,
                bytes: buf.byteLength,
                b64: buf.toString("base64"),
              },
              null,
              2,
            ),
          },
        ],
      }
    }
  )

  server.tool(
    "kill_terminal_session",
    "SIGTERM a PTY session and drop it from the alive set. Same effect as " +
      "`kill_agent_session` for the PTY family — separate name so it's obvious " +
      "what's being stopped.",
    {
      sessionId: z
        .string()
        .describe("Session id OR name from start_terminal_session."),
    },
    async input => {
      if (!ptyEnabled) return ptyNotConfigured("kill_terminal_session")
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            {
              type: "text",
              text: `kill_terminal_session: no session "${input.sessionId}"`,
            },
          ],
          isError: true,
        }
      }
      const ok = registry.kill(desc.id)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId: desc.id }, null, 2),
          },
        ],
      }
    }
  )
}
