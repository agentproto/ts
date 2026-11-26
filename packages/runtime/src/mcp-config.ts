/**
 * Per-call resolver for the top-level `mcp` config block. Same discipline as
 * `resolveMessagingDefaults`: the MCP gateways rebuild their `McpServer` on
 * every request, so reading the config here makes a `config_set` change
 * take effect on the very next call without a restart.
 */

import { loadConfig } from "./config.js"
import type { McpConfig } from "./config.js"

export type NoCallerIdentityPolicy = "block" | "ask" | "accept"

export const DEFAULT_NO_CALLER_IDENTITY: NoCallerIdentityPolicy = "block"
export const DEFAULT_MODERN_ERA = true
export const DEFAULT_HUMAN_GATE = true
export const DEFAULT_SKILLS_EXTENSION = true
export const DEFAULT_EVENTS_EXTENSION = true
export const DEFAULT_TASKS = true

export async function resolveMcpConfig(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<McpConfig> {
  try {
    return (await loadCfg()).mcp ?? {}
  } catch {
    return {}
  }
}

export async function resolveNoCallerIdentity(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<NoCallerIdentityPolicy> {
  const value = (await resolveMcpConfig(loadCfg)).noCallerIdentity
  return value === "accept" || value === "ask" ? value : DEFAULT_NO_CALLER_IDENTITY
}

export async function resolveModernEra(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<boolean> {
  const value = (await resolveMcpConfig(loadCfg)).modernEra
  return typeof value === "boolean" ? value : DEFAULT_MODERN_ERA
}

export async function resolveHumanGate(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<boolean> {
  const value = (await resolveMcpConfig(loadCfg)).humanGate
  return typeof value === "boolean" ? value : DEFAULT_HUMAN_GATE
}

export async function resolveSkillsExtension(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<boolean> {
  const value = (await resolveMcpConfig(loadCfg)).extensions?.skills
  return typeof value === "boolean" ? value : DEFAULT_SKILLS_EXTENSION
}

export async function resolveEventsExtension(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<boolean> {
  const value = (await resolveMcpConfig(loadCfg)).eventsExtension
  return typeof value === "boolean" ? value : DEFAULT_EVENTS_EXTENSION
}

export interface HumanGateSurfaceConfig {
  approvals: boolean
  runs: boolean
  approvalsUiBaseUrl?: string
}

/** Per-kind switches for the modern human gate, read on each request. All off when `mcp.humanGate` is off. */
export async function resolveHumanGateSurfaces(
  loadCfg: () => Promise<{ mcp?: McpConfig; approvals?: { uiBaseUrl?: string } }> = loadConfig,
): Promise<HumanGateSurfaceConfig> {
  const cfg = await loadCfg()
  const mcp = cfg.mcp ?? {}
  const on = typeof mcp.humanGate === "boolean" ? mcp.humanGate : DEFAULT_HUMAN_GATE
  const flag = (v: boolean | undefined): boolean => on && (typeof v === "boolean" ? v : true)
  return {
    approvals: flag(mcp.humanGateApprovals),
    runs: flag(mcp.humanGateRuns),
    ...(cfg.approvals?.uiBaseUrl ? { approvalsUiBaseUrl: cfg.approvals.uiBaseUrl } : {}),
  }
}

export interface TaskSettings {
  enabled: boolean
  tools: "both" | "agent_start" | "agent_prompt"
  ttlMs?: number
  maxTtlMs?: number
  maxPerPrincipal?: number
  resultMaxChars?: number
}

const positiveInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined

/** Every Tasks setting in one read (the projector asks per request, so a `config_set` applies at once). */
export async function resolveTaskSettings(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<TaskSettings> {
  const cfg = await resolveMcpConfig(loadCfg)
  const tools = cfg.tasksTools === "agent_start" || cfg.tasksTools === "agent_prompt" ? cfg.tasksTools : "both"
  return {
    enabled: typeof cfg.tasks === "boolean" ? cfg.tasks : DEFAULT_TASKS,
    tools,
    ...(positiveInt(cfg.tasksTtlMs) !== undefined ? { ttlMs: positiveInt(cfg.tasksTtlMs)! } : {}),
    ...(positiveInt(cfg.tasksMaxTtlMs) !== undefined ? { maxTtlMs: positiveInt(cfg.tasksMaxTtlMs)! } : {}),
    ...(positiveInt(cfg.tasksMaxPerPrincipal) !== undefined ? { maxPerPrincipal: positiveInt(cfg.tasksMaxPerPrincipal)! } : {}),
    ...(positiveInt(cfg.tasksResultMaxChars) !== undefined ? { resultMaxChars: positiveInt(cfg.tasksResultMaxChars)! } : {}),
  }
}

/** Whether the modern gateway offers the MCP Tasks extension. */
export async function resolveTasks(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<boolean> {
  const value = (await resolveMcpConfig(loadCfg)).tasks
  return typeof value === "boolean" ? value : DEFAULT_TASKS
}
