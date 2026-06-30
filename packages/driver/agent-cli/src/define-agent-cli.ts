import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createDoctype } from "@agentproto/define-doctype"
import { agentCliFrontmatterSchema } from "./schema.js"
import { createAcpProtocolArm } from "./protocol/acp-client.js"
import { createPrintSession } from "./protocol/print-arm.js"
import { composeSpawn } from "./manifest/compose.js"
import type {
  AgentCliClient,
  AgentCliDefinition,
  AgentCliHandle,
  AgentCliRuntime,
  AgentCliRuntimeSession,
  AgentCliStartOptions,
  StreamEvent,
} from "./types.js"

export const defineAgentCli = createDoctype<AgentCliDefinition, AgentCliHandle>(
  {
    aip: 45,
    name: "agent-cli",
    readIdentity: (def) => def.id,
    validate(def) {
      const result = agentCliFrontmatterSchema.safeParse(def)
      if (!result.success) {
        throw new Error(
          `defineAgentCli (AIP-45): ${result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        )
      }

      const data = result.data

      if (data.protocol === "acp" && !data.acp) {
        throw new Error(
          "defineAgentCli (AIP-45): `acp` ref is required when protocol=acp",
        )
      }
      if (data.protocol === "mcp" && !data.mcp) {
        throw new Error(
          "defineAgentCli (AIP-45): `mcp` block is required when protocol=mcp",
        )
      }
      if (data.protocol === "proprietary" && !data.adapter) {
        throw new Error(
          "defineAgentCli (AIP-45): `adapter` package is required when protocol=proprietary",
        )
      }

      if (
        data.session?.mode === "resumable" &&
        data.capabilities?.resumable !== true
      ) {
        throw new Error(
          "defineAgentCli (AIP-45): session.mode=resumable requires capabilities.resumable: true",
        )
      }
    },
    build(def) {
      return { ...def } as AgentCliHandle
    },
  },
)

export function createAgentCliRuntime(
  definition: AgentCliHandle,
): AgentCliRuntime {
  return {
    definition,
    async start(opts?: AgentCliStartOptions): Promise<AgentCliRuntimeSession> {
      const cwd = opts?.cwd ?? process.cwd()
      // Compose final argv + env from the manifest + per-call config.
      // Mode patches and option patches land BEFORE the host-provided
      // env so an operator-set option can be observed by the CLI even
      // when the manifest also touches the same env key (operator
      // intent wins). Validation runs here too — a misconfigured
      // operator throws RuntimeConfigError before we exec anything.
      const composed = composeSpawn(definition, opts?.config)
      const env: Record<string, string> = {
        ...filterStringEnv(process.env),
        ...composed.env,
        ...(opts?.env ?? {}),
      }

      // The print arm spawns a fresh subprocess per turn — no
      // long-lived child, no AgentCliClient connect/events cycle.
      // Short-circuit here so buildProtocolArm is never called for it.
      if (definition.protocol === "print") {
        return createPrintSession({
          bin: definition.bin,
          baseArgs: composed.binArgs,
          cwd,
          env,
          ...(opts?.resumeSessionId
            ? { resumeSessionId: opts.resumeSessionId }
            : {}),
          printConfig: definition.print,
        })
      }

      const child = spawn(definition.bin, composed.binArgs, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts?.signal,
      })

      // Drain child.stderr — without this the kernel pipe buffer
      // (~64 KB on macOS / Linux) eventually fills up and blocks the
      // child mid-write, hanging the entire ACP exchange. Buffer the
      // last few KB so a downstream error event can attach the tail
      // for debugging — adapters like claude-agent-acp print useful
      // context here ("not authenticated", "model gated") that the
      // JSON-RPC reply would otherwise reduce to "Invalid params".
      const stderrBuf: string[] = []
      const STDERR_KEEP_LINES = 80
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (!line) continue
          stderrBuf.push(line)
          if (stderrBuf.length > STDERR_KEEP_LINES) stderrBuf.shift()
        }
      })

      const arm = buildProtocolArm(definition, child, cwd)
      arm._stderrTail = () => stderrBuf.join("\n")

      const abortController = new AbortController()
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => abortController.abort(), {
          once: true,
        })
      }
      // Extract model + effort from the config options so the protocol
      // arm can apply them via ACP session/set_config_option — the ACP
      // wrapper (claude-agent-acp) does not read its own CLI args and
      // forward them to claude, so bin_args_template alone is not
      // sufficient. The compose step still adds them to binArgs as a
      // best-effort fallback for non-ACP arms.
      const optModel = opts?.config?.options?.model
      const optEffort = opts?.config?.options?.effort
      // Model-selection strategy (AgentCliModels.apply, default "config"):
      //   "config"  → apply via ACP session config (set_config_option) at
      //               connect — works for claude-code.
      //   "command" → the ACP session config is a no-op on this agent
      //               (e.g. hermes silently keeps its own default), so we
      //               DON'T pass model to connect; instead we send a
      //               `/model <id>` control turn after newSession (below).
      const modelApply = definition.models?.apply ?? "config"
      const configModel =
        optModel && modelApply === "config" ? String(optModel) : undefined
      await arm.connect({
        cwd,
        env,
        abortSignal: abortController.signal,
        ...(opts?.resumeSessionId
          ? { resumeSessionId: opts.resumeSessionId }
          : {}),
        ...(opts?.mcpServers ? { mcpServers: opts.mcpServers } : {}),
        ...(configModel ? { model: configModel } : {}),
        ...(optEffort ? { effort: String(optEffort) } : {}),
      })

      // "command" model strategy: switch the model via a drained `/model
      // <id>` control turn. Best-effort — a failure is warned, never fatal,
      // so the session still starts (on the agent's default model).
      if (optModel && modelApply === "command") {
        await applyModelCommand(arm, String(optModel))
      }

      // Prefer the protocol-layer session id (ACP, etc.) so the host
      // can persist it for a future native-resume. Fall back to a
      // random UUID for protocols that don't model sessions — keeps
      // the field always-populated for downstream loggers.
      const sessionId = arm.sessionId ?? randomUUID()

      return {
        sessionId,
        send(message): AsyncIterable<StreamEvent> {
          const turnId = randomUUID()
          return promptTurn(arm, turnId, message)
        },
        async cancel() {
          abortController.abort()
        },
        async close() {
          await arm.close()
          if (!child.killed) child.kill("SIGTERM")
        },
      }
    },
  }
}

/**
 * Switch the active model via a `/model <id>` control turn, for adapters
 * whose ACP session config doesn't select the model (`models.apply:
 * "command"`, e.g. hermes). The turn is fully drained so the switch
 * completes before the caller's first real turn. Best-effort: a transport
 * failure or a missing acknowledgement is warned, never thrown — the
 * session simply continues on the agent's default model.
 */
async function applyModelCommand(
  arm: AgentCliClient,
  modelId: string,
): Promise<void> {
  const turnId = randomUUID()
  let acked = false
  try {
    for await (const evt of promptTurn(arm, turnId, {
      type: "text",
      text: `/model ${modelId}`,
    })) {
      // Loose check across the serialised event — hermes replies
      // "Model switched to: <id> · Provider: …". We don't couple to a
      // specific StreamEvent shape; any "switch" mention = acknowledged.
      if (/switch|model\s+set|now using/i.test(JSON.stringify(evt))) acked = true
    }
  } catch (err) {
    console.warn(
      `[agent-cli] /model ${modelId} control turn failed (continuing on default):`,
      err instanceof Error ? err.message : err,
    )
    return
  }
  if (!acked) {
    console.warn(
      `[agent-cli] /model ${modelId}: no switch acknowledgement — agent may be on its default model`,
    )
  }
}

async function* promptTurn(
  arm: AgentCliClient,
  turnId: string,
  message: unknown,
): AsyncIterable<StreamEvent> {
  await arm.send(turnId, message)
  // Re-attach the recent stderr tail to error events. The ACP layer
  // surfaces a terse `{message: "Invalid params"}`; the child's
  // stderr almost always has a more useful line ("npx claude-agent-acp:
  // not authenticated, run `claude login`"). Hosts read `error.data`
  // when present, falling back to `message` for older payloads.
  const stderrTail = arm._stderrTail
  for await (const evt of arm.events()) {
    if (evt.kind === "error" && typeof stderrTail === "function") {
      const tail = stderrTail()
      if (tail) {
        const existing = (evt.error.data ?? {}) as Record<string, unknown>
        evt.error.data = { ...existing, stderr: tail }
      }
    }
    yield evt
  }
}

function buildProtocolArm(
  def: AgentCliHandle,
  child: ChildProcess,
  cwd: string,
): AgentCliClient {
  switch (def.protocol) {
    case "acp":
      return createAcpProtocolArm({
        child,
        cwd,
        clientInfo: { name: def.id, version: def.version },
      })
    case "mcp":
      throw new Error("createAgentCliRuntime: mcp protocol arm not yet implemented")
    case "proprietary":
      throw new Error(
        "createAgentCliRuntime: proprietary protocol arm not yet implemented",
      )
    case "print":
      // Unreachable: print is handled by the early-return in start() above.
      throw new Error("createAgentCliRuntime: print arm bypasses buildProtocolArm")
  }
}

function filterStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}
