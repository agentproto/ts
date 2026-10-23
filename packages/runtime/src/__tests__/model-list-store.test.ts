import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inModelList } from "@agentproto/model-catalog/lists"
import {
  deleteModelList,
  getModelListSource,
  loadModelListSource,
  loadModelLists,
  modelListsPath,
  resetModelListSource,
  saveModelList,
  seedModelListSource,
  ZERO_COST_LIST_ID,
} from "../model-list-store.js"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agentproto-model-lists-"))
  process.env.HOME = home
  resetModelListSource()
})

afterEach(async () => {
  if (process.env.HOME === home) delete process.env.HOME
  resetModelListSource()
  await rm(home, { recursive: true, force: true })
})

describe("model list store", () => {
  it("writes the zero-cost seed when the file is absent, mode 0600", async () => {
    const file = await loadModelLists()
    expect(file.version).toBe(1)
    expect(file.lists).toEqual([
      {
        id: ZERO_COST_LIST_ID,
        label: "Zero-cost models",
        include: [{ kind: "tag", value: "price:zero" }],
      },
    ])
    const mode = (await stat(modelListsPath())).mode & 0o777
    expect(mode).toBe(0o600)
    expect(JSON.parse(await readFile(modelListsPath(), "utf8"))).toMatchObject({
      version: 1,
    })
  })

  it("a malformed file is a hard error naming the path, never silently empty", async () => {
    await mkdir(join(home, ".agentproto"), { recursive: true })
    await writeFile(modelListsPath(), "{ not json", "utf8")
    await expect(loadModelLists()).rejects.toThrow(/malformed/)
    await expect(loadModelLists()).rejects.toThrow(modelListsPath())
  })

  it("serves the seed before boot, and refreshes the sync source on save/delete", async () => {
    expect(getModelListSource().get(ZERO_COST_LIST_ID)).toBeDefined()
    expect(seedModelListSource().get(ZERO_COST_LIST_ID)).toBeDefined()
    expect(inModelList("big-pickle", ZERO_COST_LIST_ID, getModelListSource())).toBe(true)

    await loadModelListSource()
    await saveModelList({ id: "pinned", ids: ["custom/model"] })
    expect(getModelListSource().get("pinned")).toEqual({
      id: "pinned",
      ids: ["custom/model"],
    })

    expect(await deleteModelList("pinned")).toBe(true)
    expect(getModelListSource().get("pinned")).toBeUndefined()
    expect(await deleteModelList("pinned")).toBe(false)
  })
})
