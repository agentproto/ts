/**
 * clients — is the daemon's MCP server registered with each detected coding
 * client. install-state.json says what `install-mcp` wrote; the client's
 * config is re-read to confirm the entry is still there (users edit
 * configs), and a pinned URL is checked against the daemon's port.
 */

import {
  DEFAULT_PORT,
  inspectMcpRegistration,
  type AgentDetection,
  type McpRegistrationInspection,
} from "../../commands/install-mcp.js"
import type { OnboardingStep, StepCheck, StepContext } from "../types.js"
import { errorMessage, readText, tildify } from "./_util.js"

function portOf(url: string): number | null {
  try {
    const u = new URL(url)
    if (u.port) return Number(u.port)
    return u.protocol === "https:" ? 443 : 80
  } catch {
    return null
  }
}

async function inspect(
  ctx: StepContext,
  client: AgentDetection,
  paths: readonly string[],
): Promise<{ path: string; result: McpRegistrationInspection } | null> {
  for (const path of paths) {
    const text = await readText(ctx, path)
    if (text === null) continue
    const result = inspectMcpRegistration(client.name, text)
    if (result.present) return { path, result }
  }
  return null
}

export const clientsStep: OnboardingStep = {
  id: "clients",
  title: "Coding clients (MCP)",
  required: false,
  async detect(ctx) {
    let clients: AgentDetection[]
    try {
      clients = await ctx.sources.detectClients()
    } catch (err) {
      return [{ id: "clients.detect", title: "Coding clients", status: "warn", detail: `not checked: ${errorMessage(err)}` }]
    }
    if (clients.length === 0) {
      return [{ id: "clients.detect", title: "Coding clients", status: "skipped", detail: "none detected" }]
    }
    const state = await ctx.sources.loadMcpInstallState().catch(() => ({ entries: [] }))
    const config = await ctx.sources.loadConfig()
    const daemonPort = config.daemon?.port ?? DEFAULT_PORT

    const checks: StepCheck[] = []
    for (const client of clients) {
      const recorded = state.entries.find((e) => e.agent === client.name && e.appId === undefined)
      const paths = [...new Set([...(recorded ? [recorded.configPath] : []), client.configPath])]
      const found = await inspect(ctx, client, paths)
      const id = `clients.${client.name}`
      const fix = `agentproto install-mcp --agent ${client.name}`
      if (!found) {
        checks.push({
          id,
          title: client.label,
          status: "warn",
          detail: recorded
            ? `recorded in install-state.json, but the agentproto entry is gone from ${tildify(ctx, recorded.configPath)}`
            : "detected, agentproto MCP server not registered",
          fix,
          data: { registered: false, recorded: recorded !== undefined, configPath: client.configPath },
        })
        continue
      }
      const pinned = found.result.url ? portOf(found.result.url) : null
      const data = {
        registered: true,
        recorded: recorded !== undefined,
        configPath: found.path,
        url: found.result.url ?? null,
      }
      if (pinned !== null && pinned !== daemonPort) {
        checks.push({
          id,
          title: client.label,
          status: "broken",
          detail: `registered at ${found.result.url}, but the daemon port is ${daemonPort}`,
          fix: "agentproto install-mcp --update",
          data,
        })
        continue
      }
      checks.push({ id, title: client.label, status: "ok", detail: `registered in ${tildify(ctx, found.path)}`, data })
    }
    return checks
  },
}
