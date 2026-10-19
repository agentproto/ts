/**
 * Typed, best-effort persistence for THE one LLM pricing catalog snapshot the
 * `catalog_diff` tool diffs against on its next call. Unlike the per-profile
 * quota store (`remaining-quota-store.ts`), there is exactly ONE snapshot —
 * each `catalog_diff` call overwrites the whole file with "now".
 *
 * Mirrors that store's primitives: a versioned `{ version: 1, … }` JSON file
 * under `~/.agentproto/`, `node:fs/promises`, mode 0600, a load that reads
 * missing/corrupt as empty and NEVER throws. `dir` is injectable so tests can
 * round-trip against a temp directory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import type { CatalogSnapshot } from "@agentproto/model-intel"

const snapshotEntrySchema = z.object({
  id: z.string(),
  inputPer1M: z.number(),
  outputPer1M: z.number(),
  free: z.boolean(),
}) satisfies z.ZodType<CatalogSnapshot[string]>

const snapshotSchema = z.record(z.string(), snapshotEntrySchema) satisfies z.ZodType<CatalogSnapshot>

const catalogFileSchema = z.object({
  version: z.literal(1),
  snapshot: snapshotSchema,
  asOf: z.string(),
})

/** Version-1 on-disk shape: `{ version: 1, snapshot: {…}, asOf: <ISO> }`. */
export type CatalogSnapshotFile = z.infer<typeof catalogFileSchema>

/** Options accepted by every store fn. `dir` overrides the `~/.agentproto`
 *  home directory (tests inject a temp dir). */
export interface CatalogSnapshotStoreOptions {
  dir?: string
}

function catalogDir(opts?: CatalogSnapshotStoreOptions): string {
  return opts?.dir ?? resolve(homedir(), ".agentproto")
}

function catalogPath(opts?: CatalogSnapshotStoreOptions): string {
  return join(catalogDir(opts), "catalog-snapshot.json")
}

function emptyFile(): CatalogSnapshotFile {
  // `asOf` epoch marker: "no snapshot has ever been recorded". ISO 0-time
  // rather than a null so the field stays a plain string for consumers.
  return { version: 1, snapshot: {}, asOf: "1970-01-01T00:00:00.000Z" }
}

/** Load the stored snapshot. ENOENT / malformed / schema-mismatch → empty
 *  file (epoch `asOf`, empty snapshot). Never throws. */
export async function loadCatalogSnapshotStore(
  opts?: CatalogSnapshotStoreOptions,
): Promise<CatalogSnapshotFile> {
  try {
    const raw = await readFile(catalogPath(opts), "utf8")
    return catalogFileSchema.parse(JSON.parse(raw))
  } catch {
    return emptyFile()
  }
}

/** Overwrite the stored snapshot wholesale (there is only ever ONE catalog
 *  snapshot). May throw on a genuine write failure (callers wrap this
 *  best-effort). */
export async function recordCatalogSnapshot(
  snapshot: CatalogSnapshot,
  opts?: CatalogSnapshotStoreOptions,
): Promise<void> {
  const file: CatalogSnapshotFile = {
    version: 1,
    snapshot,
    asOf: new Date().toISOString(),
  }
  const dir = catalogDir(opts)
  await mkdir(dir, { recursive: true })
  // mode 0600 like the other stores under ~/.agentproto. Direct write, no
  // tmp+rename: a torn snapshot only costs a re-diff (empty baseline), same
  // tradeoff `remaining-quota-store.ts` accepts.
  await writeFile(catalogPath(opts), JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}
