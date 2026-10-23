/**
 * User-owned model lists — the persisted form of a named model selection.
 *
 * `~/.agentproto/model-lists.json` holds `{ version: 1, lists: ModelList[] }`.
 * The file is seeded with `zero-cost` on first load (price 0/0), which is now
 * the ONE definition of "free" in code: every former free predicate asks
 * `inModelList(model, "zero-cost", getModelListSource())` instead.
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
import type { ModelList, ModelListSource } from "@agentproto/model-catalog/lists"

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

/** The seed written on first load only when the file is absent. */
export const SEED_MODEL_LISTS: readonly ModelList[] = [
  {
    id: ZERO_COST_LIST_ID,
    label: "Zero-cost models",
    include: [{ kind: "tag", value: "price:zero" }],
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
    return modelListsFileSchema.parse(JSON.parse(raw))
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

function sourceFrom(lists: readonly ModelList[]): ModelListSource {
  const byId = new Map(lists.map(list => [list.id, list]))
  return { get: id => byId.get(id) }
}

/** The seed-backed source, valid before the daemon has loaded the file. */
export function seedModelListSource(): ModelListSource {
  return sourceFrom(SEED_MODEL_LISTS)
}

let syncSource: ModelListSource | undefined

/** Process-wide synchronous source. Before boot it serves the seed. */
export function getModelListSource(): ModelListSource {
  return syncSource ?? seedModelListSource()
}

/** Load the file at daemon boot and install it as the sync source. */
export async function loadModelListSource(): Promise<ModelListSource> {
  const file = await loadModelLists()
  syncSource = sourceFrom(file.lists)
  return syncSource
}

/** Add or replace a list by id (validated), then refresh the sync source. */
export async function saveModelList(list: ModelList): Promise<ModelList> {
  const validated = modelListSchema.parse(list)
  const file = await loadModelLists()
  const index = file.lists.findIndex(existing => existing.id === validated.id)
  if (index === -1) file.lists.push(validated)
  else file.lists[index] = validated
  await writeModelLists(file)
  syncSource = sourceFrom(file.lists)
  return validated
}

export async function deleteModelList(id: string): Promise<boolean> {
  const file = await loadModelLists()
  const index = file.lists.findIndex(list => list.id === id)
  if (index === -1) return false
  file.lists.splice(index, 1)
  await writeModelLists(file)
  syncSource = sourceFrom(file.lists)
  return true
}

/** Test helper: forget any loaded source so the seed applies again. */
export function resetModelListSource(): void {
  syncSource = undefined
}
