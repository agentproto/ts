/**
 * User-owned model lists — the persisted form of a named model selection.
 *
 * `~/.agentproto/model-lists.json` holds `{ version: 1, lists: ModelList[] }`.
 * The file is seeded with `zero-cost` (price 0/0) on first load. Model rules
 * never read it by name: a session's `ModelPolicy` (model-policy.ts) refers to
 * list ids chosen by the user.
 *
 * Writes are 0600 like the sibling stores. A MALFORMED file is a hard error
 * naming the path — unlike the preset stores, silently treating a broken list
 * file as empty would make every free model look paid and break spawning
 * without telling anyone.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import {
  inModelList,
  type ModelList,
  type ModelListSource,
} from "@agentproto/model-catalog/lists"

const accessTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), id: z.string().min(1) }),
  z.object({ kind: z.literal("tag"), value: z.string().min(1) }),
  z.object({ kind: z.literal("provider"), value: z.string().min(1) }),
  z.object({
    kind: z.literal("priceTier"),
    value: z.enum(["low", "mid", "high", "premium"]),
  }),
  z.object({
    kind: z.literal("kind"),
    value: z.enum(["llm", "image", "video", "audio"]),
  }),
])

export const modelSelectorSchema = z.union([
  accessTargetSchema,
  z.object({
    kind: z.literal("price"),
    maxInPer1M: z.number().nonnegative().optional(),
    maxOutPer1M: z.number().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("context"), min: z.number().nonnegative() }),
  z.object({ kind: z.literal("variant"), value: z.string().min(1) }),
  z.object({ kind: z.literal("list"), id: z.string().min(1) }),
])

export const modelListSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  label: z.string().min(1).optional(),
  include: z.array(modelSelectorSchema).optional(),
  exclude: z.array(modelSelectorSchema).optional(),
  ids: z.array(z.string().min(1)).optional(),
  order: z
    .enum(["listed", "cheapest", "largest-context", "newest"])
    .optional(),
  rotation: z
    .enum(["priority", "round-robin", "least-recently-limited"])
    .optional(),
}) satisfies z.ZodType<ModelList>

const modelListsFileSchema = z.object({
  version: z.literal(1),
  lists: z.array(modelListSchema),
})

export type ModelListsFile = z.infer<typeof modelListsFileSchema>

export const ZERO_COST_LIST_ID = "zero-cost"
export const DEFAULT_ROTATION_LIST_ID = "default-rotation"

/** Seeds whose definition is an entitlement boundary, never user data. An
 *  agent that can rewrite `zero-cost` can widen a `free-only` profile, so its
 *  stored definition is ignored and edits are refused. */
export const IMMUTABLE_SEED_LIST_IDS: ReadonlySet<string> = new Set([
  ZERO_COST_LIST_ID,
])

/** Seed lists. Absent seeds are added on every load (so a file written by an
 *  earlier build gains new seeds). An existing list with the same id is kept
 *  as user data, except an immutable seed, which is always restored. */
export const SEED_MODEL_LISTS: readonly ModelList[] = [
  {
    id: ZERO_COST_LIST_ID,
    label: "Zero-cost models",
    include: [{ kind: "tag", value: "price:zero" }],
  },
  {
    id: DEFAULT_ROTATION_LIST_ID,
    label: "Default rotation targets",
    ids: [
      "opencode/mimo-v2.6-flash-free",
      "opencode/deepseek-v4.1-flash-free",
      "opencode/glm-5.3-flash-free",
    ],
  },
]

export class ModelListStoreError extends Error {
  readonly name = "ModelListStoreError"
}

export function modelListsPath(): string {
  return resolve(homedir(), ".agentproto", "model-lists.json")
}

function seedFile(): ModelListsFile {
  return {
    version: 1,
    lists: SEED_MODEL_LISTS.map(list => structuredClone(list)),
  }
}

/** Append every seed list whose id is missing. An existing user-edited list is
 *  kept, except for an immutable seed (the entitlement boundary), which is
 *  always restored to its built-in definition. */
function withMissingSeeds(file: ModelListsFile): {
  file: ModelListsFile
  changed: boolean
} {
  let changed = false
  for (const seed of SEED_MODEL_LISTS) {
    const index = file.lists.findIndex(list => list.id === seed.id)
    if (index === -1) {
      file.lists.push(structuredClone(seed))
      changed = true
      continue
    }
    if (!IMMUTABLE_SEED_LIST_IDS.has(seed.id)) continue
    if (JSON.stringify(file.lists[index]) === JSON.stringify(seed)) continue
    file.lists[index] = structuredClone(seed)
    changed = true
  }
  return { file, changed }
}

async function writeModelLists(file: ModelListsFile): Promise<void> {
  const dir = join(homedir(), ".agentproto")
  await mkdir(dir, { recursive: true })
  await writeFile(modelListsPath(), JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}

/** Load the persisted file. Absent = write and return the seed; malformed =
 *  throw naming the path (never silently empty). */
export async function loadModelLists(): Promise<ModelListsFile> {
  let raw: string
  try {
    raw = await readFile(modelListsPath(), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const file = seedFile()
      await writeModelLists(file)
      return file
    }
    throw err
  }
  try {
    const parsed = modelListsFileSchema.parse(JSON.parse(raw))
    const merged = withMissingSeeds(parsed)
    if (merged.changed) await writeModelLists(merged.file)
    return merged.file
  } catch (err) {
    throw new ModelListStoreError(
      `model lists file at ${modelListsPath()} is malformed: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Fix it or move it aside to ${modelListsPath()}.bak; it is never ` +
        `silently treated as empty.`,
    )
  }
}

export async function listModelLists(): Promise<ModelList[]> {
  return (await loadModelLists()).lists
}

export async function getModelList(id: string): Promise<ModelList | undefined> {
  return (await loadModelLists()).lists.find(list => list.id === id)
}

const SEED_BY_ID = new Map(SEED_MODEL_LISTS.map(list => [list.id, list]))

/** Seed lists fall back to their built-in definition when the stored file has
 *  lost them, so a deleted/corrupted file can never make a seed id look
 *  absent (fail closed: the model stays zero-cost, the rotation set stays).
 *  An immutable seed always resolves to its built-in definition, even if the
 *  file carries a tampered copy. */
export function modelListSourceFromLists(
  lists: readonly ModelList[],
): ModelListSource {
  const byId = new Map(lists.map(list => [list.id, list]))
  return {
    get: id =>
      IMMUTABLE_SEED_LIST_IDS.has(id)
        ? SEED_BY_ID.get(id)
        : (byId.get(id) ?? SEED_BY_ID.get(id)),
  }
}

/** The seed-backed source, valid before the daemon has loaded the file. */
export function seedModelListSource(): ModelListSource {
  return modelListSourceFromLists(SEED_MODEL_LISTS)
}

let syncSource: ModelListSource | undefined

/** Process-wide synchronous source. Before boot it serves the seed. */
export function getModelListSource(): ModelListSource {
  return syncSource ?? seedModelListSource()
}

/** Load the file at daemon boot and install it as the sync source. */
export async function loadModelListSource(): Promise<ModelListSource> {
  const file = await loadModelLists()
  syncSource = modelListSourceFromLists(file.lists)
  return syncSource
}

/** Fail-closed membership for entitlement / rotation hot paths: an unknown
 *  list or a cycle is "not in the list", never a throw on spawn or retry. */
export function isInModelList(
  model: string,
  id: string,
  src: ModelListSource = getModelListSource(),
): boolean {
  try {
    return inModelList(model, id, src)
  } catch {
    return false
  }
}

function referencesList(list: ModelList, id: string): boolean {
  return [...(list.include ?? []), ...(list.exclude ?? [])].some(
    selector => selector.kind === "list" && selector.id === id,
  )
}

/** Add or replace a list by id (validated), then refresh the sync source. */
export async function saveModelList(list: ModelList): Promise<ModelList> {
  const validated = modelListSchema.parse(list)
  if (IMMUTABLE_SEED_LIST_IDS.has(validated.id)) {
    throw new ModelListStoreError(
      `model list "${validated.id}" is built-in and cannot be edited; ` +
        `create a new list instead.`,
    )
  }
  const file = await loadModelLists()
  const index = file.lists.findIndex(existing => existing.id === validated.id)
  if (index === -1) file.lists.push(validated)
  else file.lists[index] = validated
  await writeModelLists(file)
  syncSource = modelListSourceFromLists(file.lists)
  return validated
}

export async function deleteModelList(id: string): Promise<boolean> {
  if (SEED_BY_ID.has(id)) {
    throw new ModelListStoreError(
      `model list "${id}" is a built-in seed and cannot be deleted.`,
    )
  }
  const file = await loadModelLists()
  const index = file.lists.findIndex(list => list.id === id)
  if (index === -1) return false
  const referencing = file.lists
    .filter(list => list.id !== id && referencesList(list, id))
    .map(list => list.id)
  if (referencing.length > 0) {
    throw new ModelListStoreError(
      `model list "${id}" is referenced by ${referencing
        .map(ref => `"${ref}"`)
        .join(", ")}; update or delete those lists first.`,
    )
  }
  file.lists.splice(index, 1)
  await writeModelLists(file)
  syncSource = modelListSourceFromLists(file.lists)
  return true
}

/** Test helper: forget any loaded source so the seed applies again. */
export function resetModelListSource(): void {
  syncSource = undefined
}
