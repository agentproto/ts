import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createDoctype } from "@agentproto/define-doctype"
import { agentCliFrontmatterSchema } from "./schema.js"
import { createAcpProtocolArm } from "./protocol/acp-client.js"
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
      const env: Record<string, string> = {
        ...filterStringEnv(process.env),
        ...(opts?.env ?? {}),
      }

      const child = spawn(definition.bin, definition.bin_args ?? [], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts?.signal,
      })

      const arm = buildProtocolArm(definition, child, cwd)

      const abortController = new AbortController()
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => abortController.abort(), {
          once: true,
        })
      }
      await arm.connect({
        cwd,
        env,
        abortSignal: abortController.signal,
      })

      const sessionId = randomUUID()

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

async function* promptTurn(
  arm: AgentCliClient,
  turnId: string,
  message: unknown,
): AsyncIterable<StreamEvent> {
  await arm.send(turnId, message)
  for await (const evt of arm.events()) yield evt
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
  }
}

function filterStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}
