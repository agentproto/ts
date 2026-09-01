/**
 * Filesystem `BatchStore` — a batch outlives the process; anyone with the id
 * can re-attach. Layout: `<stateDir>/batches/<id>/{manifest.json,
 * requests.jsonl, results.jsonl}`. `stateDir` is an explicit constructor
 * option — callers decide where state lives (a workspace dir, `~/.agentproto`,
 * a tmpdir in tests); this package never defaults to a real home directory.
 */

import { randomBytes } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import {
  batchHandleSchema,
  batchRequestSchema,
  batchResultSchema,
  batchSubmitOptionsSchema,
  type BatchHandle,
  type BatchRequest,
  type BatchResult,
  type BatchSubmitOptions,
} from "./types.js"

const manifestSchema = z.object({
  handle: batchHandleSchema,
  submitOptions: batchSubmitOptionsSchema.optional(),
})

/** A batch's full durable state: the handle, what was sent, and what has
 *  come back so far — deduped by `customId`, last write wins. */
export interface BatchRecord {
  readonly handle: BatchHandle
  readonly submitOptions?: BatchSubmitOptions
  readonly requests: readonly BatchRequest[]
  readonly results: readonly BatchResult[]
}

export interface BatchStoreOptions {
  readonly stateDir: string
}

function parseJsonl<T>(raw: string, schema: z.ZodType<T>): T[] {
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => schema.parse(JSON.parse(line)))
}

export class BatchStore {
  private readonly root: string

  constructor(opts: BatchStoreOptions) {
    this.root = path.join(opts.stateDir, "batches")
  }

  private dir(id: string): string {
    return path.join(this.root, id)
  }

  private async writeAtomic(target: string, content: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${randomBytes(8).toString("hex")}`
    await writeFile(tmp, content, "utf8")
    await rename(tmp, target)
  }

  /** Persist a newly submitted batch: the handle, submit options, and the
   *  exact requests sent. Called once per submit — before any results exist. */
  async create(
    handle: BatchHandle,
    requests: readonly BatchRequest[],
    submitOptions?: BatchSubmitOptions,
  ): Promise<void> {
    const dir = this.dir(handle.id)
    await mkdir(dir, { recursive: true })
    await this.writeAtomic(
      path.join(dir, "manifest.json"),
      JSON.stringify({ handle, submitOptions }, null, 2),
    )
    const lines = requests.map(request => JSON.stringify(request))
    await this.writeAtomic(path.join(dir, "requests.jsonl"), lines.map(l => `${l}\n`).join(""))
  }

  /** Append newly landed results. Safe to call repeatedly as results arrive;
   *  `load` dedupes by `customId` so a re-appended result (after a crash and
   *  retry) doesn't produce two entries. */
  async appendResults(id: string, results: readonly BatchResult[]): Promise<void> {
    if (results.length === 0) return
    const dir = this.dir(id)
    await mkdir(dir, { recursive: true })
    const lines = results.map(result => `${JSON.stringify(result)}\n`).join("")
    await appendFile(path.join(dir, "results.jsonl"), lines, "utf8")
  }

  /** Load a batch's full record, or `undefined` if no manifest exists for it. */
  async load(id: string): Promise<BatchRecord | undefined> {
    const dir = this.dir(id)
    const manifestRaw = await readFile(path.join(dir, "manifest.json"), "utf8").catch(
      () => undefined,
    )
    if (manifestRaw === undefined) return undefined
    const manifest = manifestSchema.parse(JSON.parse(manifestRaw))

    const requestsRaw = await readFile(path.join(dir, "requests.jsonl"), "utf8").catch(() => "")
    const requests = parseJsonl(requestsRaw, batchRequestSchema)

    const resultsRaw = await readFile(path.join(dir, "results.jsonl"), "utf8").catch(() => "")
    const byCustomId = new Map<string, BatchResult>()
    for (const result of parseJsonl(resultsRaw, batchResultSchema)) {
      byCustomId.set(result.customId, result)
    }

    return {
      handle: manifest.handle,
      submitOptions: manifest.submitOptions,
      requests,
      results: Array.from(byCustomId.values()),
    }
  }

  /** All batch ids known to this store, most convenient for a caller doing
   *  `list().then(hs => hs.find(...))`-style lookups. */
  async list(): Promise<BatchHandle[]> {
    const ids = await readdir(this.root).catch((): string[] => [])
    const handles: BatchHandle[] = []
    for (const id of ids) {
      const record = await this.load(id)
      if (record) handles.push(record.handle)
    }
    return handles
  }
}
