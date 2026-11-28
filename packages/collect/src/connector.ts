import { z } from "zod"
import {
  Actor,
  CollectItem,
  MetricName,
  ObservationBase,
  PickupBase,
  type Recipe as RecipeType,
} from "./schemas"
import type { FetchTransport, SecretsPort, TransportName } from "./transport"

/** A unit of work a connector plans: stable id, plain-JSON parameters. */
export const CollectTask = z.object({
  /** Unique within its connector, and the same for the same recipe. */
  id: z.string().min(1),
  kind: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
})
export type CollectTask = z.input<typeof CollectTask>

export const CounterDeclaration = z.object({
  name: MetricName,
  /** What the number counts, e.g. `count`, `points`, `stars`. */
  unit: z.string().min(1),
  /** `root`: the root message only. `thread`: the whole thread. */
  scope: z.enum(["root", "thread"]),
  /** The platform's own main counter (at most one per connector). */
  primary: z.boolean().default(false),
})
export type CounterDeclaration = z.input<typeof CounterDeclaration>

export const AccessDeclaration = z.discriminatedUnion("level", [
  z.object({ level: z.literal("none") }),
  /** Needs the secret `secret` from the `SecretsPort`. */
  z.object({ level: z.literal("key"), secret: z.string().min(1) }),
  /** Needs a logged-in session on `site`. */
  z.object({ level: z.literal("session"), site: z.string().min(1) }),
])
export type AccessDeclaration = z.infer<typeof AccessDeclaration>

export const Capability = z.enum(["search", "list", "read-by-url", "author-profile", "re-observe"])
export type Capability = z.infer<typeof Capability>

export const Pace = z.object({
  /** Minimum interval between two requests to the same host. */
  delayMs: z.number().int().nonnegative().default(0),
  /** Most tasks this connector may start in one run. */
  maxTasksPerRun: z.number().int().positive().optional(),
})
export type Pace = z.infer<typeof Pace>

export const TransportNameSchema = z.enum(["api", "http", "browser"])

/** The data part of a connector, validated by `defineConnector`. */
export const ConnectorDeclaration = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes"),
    version: z.string().min(1),
    /** Preference order: the engine tries them in this order. */
    transports: z.array(TransportNameSchema).min(1),
    access: AccessDeclaration.default({ level: "none" }),
    capabilities: z.array(Capability).default([]),
    counters: z.array(CounterDeclaration).default([]),
    pace: Pace.default({ delayMs: 0 }),
  })
  .superRefine((d, ctx) => {
    if (new Set(d.transports).size !== d.transports.length) {
      ctx.addIssue({ code: "custom", path: ["transports"], message: "duplicate transport" })
    }
    if (d.counters.filter((c) => c.primary).length > 1) {
      ctx.addIssue({ code: "custom", path: ["counters"], message: "at most one primary counter" })
    }
    if (new Set(d.counters.map((c) => c.name)).size !== d.counters.length) {
      ctx.addIssue({ code: "custom", path: ["counters"], message: "duplicate counter" })
    }
  })

export type RecipeSource = RecipeType["sources"][number]

/** A raw body a connector fetched. The engine stores it, whatever its status. */
export interface FetchedRaw {
  url: string
  /** File extension without the dot, e.g. `json`, `html`. */
  ext: string
  bytes: Uint8Array
  httpStatus?: number
  /** Set when the page is a verification or challenge page. */
  challenge?: boolean
}

export interface FetchResult {
  raws: FetchedRaw[]
  /** Next page, linked article, author profile... queued after this task. */
  tasks?: CollectTask[]
}

export interface FetchContext {
  secrets: SecretsPort
  signal?: AbortSignal
  /** Current time from the collector's clock, ISO. */
  now: string
}

export interface ParseInput {
  connector: string
  task: z.infer<typeof CollectTask>
  raw: {
    /** Store ref of the stored body. */
    ref: string
    url: string
    ext: string
    bytes: Uint8Array
    httpStatus?: number
    fetchedAt: string
    transport: TransportName
  }
}

type Fill<T, K extends string> = Omit<T, K> & Partial<Record<K, string>>

/** An item as a connector returns it: the engine fills what it can compute. */
export type ParsedItem = Omit<z.input<typeof CollectItem>, "id" | "firstSeenAt"> & {
  /** Defaults to `source:` plus a hash of the canonical URL. */
  id?: string
  firstSeenAt?: string
}
export type ParsedObservation = Fill<z.input<typeof ObservationBase>, "measuredAt">
export type ParsedPickup = Fill<z.input<typeof PickupBase>, "firstSeenAt" | "measuredAt">

export interface ParseResult {
  items?: ParsedItem[]
  observations?: ParsedObservation[]
  actors?: Array<z.input<typeof Actor>>
  pickups?: ParsedPickup[]
}

export type ConnectorDeclarationInput = z.input<typeof ConnectorDeclaration>

/** Arrays may be readonly, so a `Connector` can be spread into a new definition. */
type ReadonlyArrays<T> = { [K in keyof T]: T[K] extends Array<infer U> | undefined ? readonly U[] | Extract<T[K], undefined> : T[K] }

export interface ConnectorDefinition extends ReadonlyArrays<ConnectorDeclarationInput> {
  /** Validates `ext` of every item this connector returns. */
  ext?: z.ZodType
  /** Deterministic: the same recipe gives the same tasks, with the same ids. No I/O. */
  plan(recipe: RecipeType, sources: RecipeSource[]): CollectTask[]
  /** The only phase that touches the network. */
  fetch(task: z.infer<typeof CollectTask>, transport: FetchTransport, context: FetchContext): Promise<FetchResult>
  /** Pure: a stored raw in, records out. Replayable without network. */
  parse(input: ParseInput): ParseResult | Promise<ParseResult>
}

export interface Connector extends Omit<ConnectorDefinition, keyof ConnectorDeclarationInput> {
  readonly id: string
  readonly version: string
  readonly transports: readonly TransportName[]
  readonly access: AccessDeclaration
  readonly capabilities: readonly Capability[]
  readonly counters: ReadonlyArray<z.infer<typeof CounterDeclaration>>
  readonly pace: Pace
}

/** Validate the declaration of a connector and return it with its defaults filled. */
export function defineConnector(definition: ConnectorDefinition): Connector {
  const { ext, plan, fetch, parse, ...declaration } = definition
  const parsed = ConnectorDeclaration.parse(declaration)
  for (const [name, fn] of Object.entries({ plan, fetch, parse })) {
    if (typeof fn !== "function") throw new TypeError(`connector ${parsed.id}: ${name} must be a function`)
  }
  return Object.freeze({ ...parsed, ext, plan, fetch, parse })
}

export interface ConnectorRegistry {
  register(connector: Connector): void
  get(id: string): Connector | undefined
  list(): Connector[]
}

/** An isolated registry (tests, embedding). */
export function createConnectorRegistry(initial: Connector[] = []): ConnectorRegistry {
  const map = new Map<string, Connector>()
  const registry: ConnectorRegistry = {
    register(connector) {
      if (map.has(connector.id)) throw new Error(`connector "${connector.id}" is already registered`)
      map.set(connector.id, connector)
    },
    get: (id) => map.get(id),
    list: () => [...map.values()],
  }
  for (const c of initial) registry.register(c)
  return registry
}

const globalRegistry = createConnectorRegistry()

/** Register a connector (shipped, external or private) in the process-wide registry. */
export function registerConnector(connector: Connector): Connector {
  globalRegistry.register(connector)
  return connector
}

export function getConnector(id: string): Connector | undefined {
  return globalRegistry.get(id)
}

export function listConnectors(): Connector[] {
  return globalRegistry.list()
}
