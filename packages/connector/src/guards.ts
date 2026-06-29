/**
 * Type guards + a zod schema for {@link ConnectorMcpDescriptor}. The guards are
 * the ergonomic narrowing path in TS; the schema is for runtime validation at
 * trust boundaries (parsing a descriptor from JSON / an API / a config file).
 */

import { z } from "zod"
import type {
  ConnectorMcpDescriptor,
  ConnectorMcpKind,
  HostedConnectorMcp,
  SandboxConnectorMcp,
  ExternalConnectorMcp,
  LocalDaemonConnectorMcp,
} from "./descriptor.js"

// ── type guards ────────────────────────────────────────────────────────────

const isKind = <K extends ConnectorMcpKind>(
  d: ConnectorMcpDescriptor,
  kind: K,
): d is Extract<ConnectorMcpDescriptor, { kind: K }> => d.kind === kind

export const isHostedConnector = (
  d: ConnectorMcpDescriptor,
): d is HostedConnectorMcp => isKind(d, "hosted")

export const isSandboxConnector = (
  d: ConnectorMcpDescriptor,
): d is SandboxConnectorMcp => isKind(d, "sandbox")

export const isExternalConnector = (
  d: ConnectorMcpDescriptor,
): d is ExternalConnectorMcp => isKind(d, "external")

export const isLocalDaemonConnector = (
  d: ConnectorMcpDescriptor,
): d is LocalDaemonConnectorMcp => isKind(d, "local-daemon")

// ── zod schema ───────────────────────────────────────────────────────────────

const hostedSchema = z.object({
  kind: z.literal("hosted"),
  slug: z.string().min(1),
  oauthProvider: z.string().optional(),
  serverUrl: z.string().min(1),
})

const sandboxSchema = z.object({
  kind: z.literal("sandbox"),
  slug: z.string().min(1),
  oauthProvider: z.string().optional(),
  runtime: z.enum(["node", "python"]).optional(),
  entryPoint: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  packageName: z.string().optional(),
})

const externalSchema = z.object({
  kind: z.literal("external"),
  slug: z.string().min(1),
  oauthProvider: z.string().optional(),
  serverUrl: z.string().optional(),
})

const localDaemonSchema = z.object({
  kind: z.literal("local-daemon"),
  slug: z.string().min(1),
  oauthProvider: z.string().optional(),
  importAlias: z.string().min(1),
  tunnelProvider: z.string().optional(),
})

/** Runtime validator for a {@link ConnectorMcpDescriptor}. */
export const connectorMcpSchema = z.discriminatedUnion("kind", [
  hostedSchema,
  sandboxSchema,
  externalSchema,
  localDaemonSchema,
])

// Compile-time proof that the zod schema and the hand-written union stay in
// sync: if either drifts, one of these assertions stops being `true` and the
// build fails. It also means `schema.parse()` already returns a value
// assignable to ConnectorMcpDescriptor — so the parse helpers need no cast.
type Expect<T extends true> = T
type _SchemaInfersType = Expect<
  z.infer<typeof connectorMcpSchema> extends ConnectorMcpDescriptor ? true : false
>
type _TypeMatchesSchema = Expect<
  ConnectorMcpDescriptor extends z.infer<typeof connectorMcpSchema> ? true : false
>

/** Parse + validate an unknown value as a {@link ConnectorMcpDescriptor}.
 *  Throws (zod error) on mismatch. */
export function parseConnectorMcp(value: unknown): ConnectorMcpDescriptor {
  return connectorMcpSchema.parse(value)
}

/** Non-throwing variant — returns null on mismatch. */
export function safeParseConnectorMcp(
  value: unknown,
): ConnectorMcpDescriptor | null {
  const result = connectorMcpSchema.safeParse(value)
  return result.success ? result.data : null
}
