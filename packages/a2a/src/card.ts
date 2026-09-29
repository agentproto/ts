import {
  A2A_BINDING_JSONRPC,
  A2A_PROTOCOL_VERSION,
  type AgentCard,
  type AgentSkill,
} from "./types.js"

/** The subset of an app's agent/workflow handle a skill is derived from. */
export interface SkillSource {
  id: string
  name?: string
  description?: string
}

export interface AppCardExposes {
  agents?: readonly string[]
  workflows?: readonly string[]
}

export interface AppCardInput {
  appId: string
  name?: string
  description?: string
  version?: string
  /** Daemon HTTP base, no trailing path (e.g. `http://127.0.0.1:4711`). */
  baseUrl: string
  /** Absent or empty → the card has no skills. Never defaults to "everything". */
  exposes?: AppCardExposes
  /** The app's agents/workflows, used only to describe exposed skills. */
  agents?: readonly SkillSource[]
  workflows?: readonly SkillSource[]
  accepts?: { tasks?: boolean }
}

export interface DaemonCardInput {
  baseUrl: string
  name?: string
  description?: string
  version?: string
  apps: readonly AppCardInput[]
}

const DEFAULT_VERSION = "0.0.0"

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

/** `<baseUrl>/a2a/apps/<appId>` — the appId is URL-encoded (`@scope/name` → `%40scope%2Fname`). */
export function appA2aUrl(baseUrl: string, appId: string): string {
  return `${trimBase(baseUrl)}/a2a/apps/${encodeURIComponent(appId)}`
}

export function appExposesAnything(app: Pick<AppCardInput, "exposes">): boolean {
  return (
    (app.exposes?.agents?.length ?? 0) > 0 ||
    (app.exposes?.workflows?.length ?? 0) > 0
  )
}

function skillsFor(app: AppCardInput): AgentSkill[] {
  const out: AgentSkill[] = []
  const add = (
    kind: "agent" | "workflow",
    ids: readonly string[] | undefined,
    sources: readonly SkillSource[] | undefined,
  ): void => {
    for (const id of ids ?? []) {
      const src = sources?.find(s => s.id === id)
      out.push({
        id: `${app.appId}/${id}`,
        name: src?.name ?? id,
        description: src?.description ?? `The ${kind} "${id}" of ${app.name ?? app.appId}.`,
        tags: [kind],
      })
    }
  }
  add("agent", app.exposes?.agents, app.agents)
  add("workflow", app.exposes?.workflows, app.workflows)
  return out
}

function baseCard(
  fields: Pick<AgentCard, "name" | "description" | "version" | "skills"> & {
    url: string
  },
): AgentCard {
  const { url, ...rest } = fields
  return {
    name: rest.name,
    description: rest.description,
    supportedInterfaces: [
      {
        url,
        protocolBinding: A2A_BINDING_JSONRPC,
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    version: rest.version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: rest.skills,
  }
}

/** Agent Card for one installed app. */
export function buildAppAgentCard(app: AppCardInput): AgentCard {
  const label = app.name ?? app.appId
  const base = app.description ?? `The ${label} agent app.`
  const description =
    app.accepts?.tasks === true
      ? base
      : `${base} This app does not accept A2A tasks.`
  return baseCard({
    name: label,
    description,
    url: appA2aUrl(app.baseUrl, app.appId),
    version: app.version ?? DEFAULT_VERSION,
    skills: skillsFor(app),
  })
}

/**
 * Agent Card for the daemon. `skills[]` aggregates every app that exposes
 * something (skill id = `<appId>/<agentOrWorkflowId>`); each app's own card
 * carries the endpoint that serves its skills.
 */
export function buildDaemonAgentCard(input: DaemonCardInput): AgentCard {
  const apps = input.apps.filter(appExposesAnything)
  return baseCard({
    name: input.name ?? "agentproto daemon",
    description:
      input.description ??
      "An agentproto daemon. Each skill is served by its app's own Agent Card at /a2a/apps/<appId>/.well-known/agent-card.json.",
    url: trimBase(input.baseUrl),
    version: input.version ?? DEFAULT_VERSION,
    skills: apps.flatMap(skillsFor),
  })
}
