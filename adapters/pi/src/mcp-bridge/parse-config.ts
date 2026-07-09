/**
 * Cast-free parser for the bridge config JSON. The adapter writes this file from
 * a typed `BridgeConfig`, but the extension reads it back as `unknown` (it's an
 * on-disk boundary), so we validate + reconstruct it with typed guards rather
 * than asserting the shape. Shared so the adapter's tests can exercise it too.
 */

import {
  asJsonObject,
  isRecord,
  type BridgeConfig,
  type BridgeServerSpec,
  type BridgeToolSpec,
  type BridgeTransport,
} from "./types.js"

function fail(path: string, detail: string): never {
  throw new Error(`[adapter-pi mcp-bridge] malformed config at ${path}: ${detail}`)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string") return undefined
    out.push(item)
  }
  return out
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") return undefined
    out[key] = raw
  }
  return out
}

function asTransport(value: unknown): BridgeTransport | undefined {
  return value === "stdio" || value === "http" || value === "sse" ? value : undefined
}

function parseServer(value: unknown, path: string): BridgeServerSpec {
  if (!isRecord(value)) fail(path, "server is not an object")
  const name = asString(value.name)
  const transport = asTransport(value.transport)
  if (name === undefined) fail(path, "server.name missing")
  if (transport === undefined) fail(path, `server "${name}" has invalid transport`)
  const command = asString(value.command)
  const args = asStringArray(value.args)
  const env = asStringRecord(value.env)
  const url = asString(value.url)
  const headers = asStringRecord(value.headers)
  return {
    name,
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers !== undefined ? { headers } : {}),
  }
}

function parseTool(value: unknown, path: string): BridgeToolSpec {
  if (!isRecord(value)) fail(path, "tool is not an object")
  const toolName = asString(value.toolName)
  const server = asString(value.server)
  const remoteName = asString(value.remoteName)
  const description = asString(value.description)
  if (toolName === undefined) fail(path, "tool.toolName missing")
  if (server === undefined) fail(path, `tool "${toolName}" has no server`)
  if (remoteName === undefined) fail(path, `tool "${toolName}" has no remoteName`)
  return {
    toolName,
    server,
    remoteName,
    description: description ?? `Bridged MCP tool ${remoteName} on ${server}.`,
    inputSchema: asJsonObject(value.inputSchema),
  }
}

/** Validate + reconstruct a `BridgeConfig` from parsed JSON. Throws on shape. */
export function parseBridgeConfig(value: unknown, path: string): BridgeConfig {
  if (!isRecord(value)) fail(path, "root is not an object")
  if (!Array.isArray(value.servers)) fail(path, "servers is not an array")
  if (!Array.isArray(value.tools)) fail(path, "tools is not an array")
  return {
    servers: value.servers.map(server => parseServer(server, path)),
    tools: value.tools.map(tool => parseTool(tool, path)),
  }
}
