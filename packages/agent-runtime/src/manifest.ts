/**
 * MultiAgentRuntime manifest schema + loader.
 *
 * The manifest is markdown with YAML frontmatter (matching @agentproto's
 * doctype convention used by ROLE.md, OPERATOR.md, etc.). The frontmatter
 * is the structured contract; the markdown body is human-readable
 * documentation of what the swarm does.
 *
 * Loader is filesystem-bound but parsing is pure — the schema can be used
 * by tests with inline strings via `parseManifest()`.
 */

import { readFile } from "node:fs/promises"
import { resolve as resolvePath, dirname } from "node:path"
import matter from "gray-matter"
import { z } from "zod"

export const MULTI_AGENT_RUNTIME_SCHEMA = "agentruntimes/v1"
export const MULTI_AGENT_RUNTIME_KIND = "MultiAgentRuntime"

const AdapterConfigSchema = z
  .object({
    kind: z.string().min(1),
  })
  .loose()

const ParticipantConfigSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    model: z.string().min(1).optional(),
  })
  .loose()

const ParticipantManifestSchema = z
  .object({
    id: z.string().min(1),
    executor: z.string().min(1),
    displayName: z.string().min(1).optional(),
    role: z.string().optional(),
    config: ParticipantConfigSchema.optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

export type ParticipantManifestConfig = z.infer<typeof ParticipantConfigSchema>

export const MultiAgentRuntimeManifestSchema = z
  .object({
    schema: z.literal(MULTI_AGENT_RUNTIME_SCHEMA),
    kind: z.literal(MULTI_AGENT_RUNTIME_KIND),
    id: z.string().min(1),
    participants: z.array(ParticipantManifestSchema).min(1),
    substrate: AdapterConfigSchema,
    dispatcher: AdapterConfigSchema,
    state: AdapterConfigSchema.optional(),
    lifecycle: z
      .object({
        onTurnEnd: z.boolean().optional(),
        onMention: z.boolean().optional(),
        onIdle: z.boolean().optional(),
      })
      .optional(),
  })
  .loose()

export type MultiAgentRuntimeManifest = z.infer<
  typeof MultiAgentRuntimeManifestSchema
>

export type LoadedManifest = {
  readonly manifest: MultiAgentRuntimeManifest
  readonly body: string
  readonly path: string
  /** Absolute directory of the manifest file — adapter configs that reference paths resolve relative to this. */
  readonly baseDir: string
}

export function parseManifest(source: string): MultiAgentRuntimeManifest {
  const parsed = matter(source)
  return MultiAgentRuntimeManifestSchema.parse(parsed.data)
}

export async function loadManifest(path: string): Promise<LoadedManifest> {
  const abs = resolvePath(path)
  const raw = await readFile(abs, "utf8")
  const parsed = matter(raw)
  const manifest = MultiAgentRuntimeManifestSchema.parse(parsed.data)
  return {
    manifest,
    body: parsed.content,
    path: abs,
    baseDir: dirname(abs),
  }
}

/** Resolve a path string from a manifest field, relative to the manifest's directory. */
export function resolveManifestPath(loaded: LoadedManifest, value: string): string {
  return resolvePath(loaded.baseDir, value)
}
