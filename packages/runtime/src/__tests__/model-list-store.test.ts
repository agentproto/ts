import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inModelList } from "@agentproto/model-catalog/lists"
import {
  deleteModelList,
  getModelListSource,
  isInModelList,
  loadModelListSource,
  loadModelLists,
  modelListSourceFromLists,
  modelListsPath,
  resetModelListSource,
  saveModelList,
  seedModelListSource,
  DEFAULT_ROTATION_LIST_ID,
  SEED_MODEL_LISTS,
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
  it("writes both seeds when the file is absent, mode 0600", async () => {
    const file = await loadModelLists()
    expect(file.version).toBe(1)
    // Which models the rotation names is the seed's business, not this
    // test's: assert the persisted file mirrors the shipped seeds AND that the
    // seeds have the expected shape (so the mirror check cannot pass on an
    // empty or malformed seed).
    expect(SEED_MODEL_LISTS.map(l => l.id)).toEqual([ZERO_COST_LIST_ID, DEFAULT_ROTATION_LIST_ID])
    const rotation = SEED_MODEL_LISTS.find(l => l.id === DEFAULT_ROTATION_LIST_ID)
    expect(rotation?.ids?.length).toBeGreaterThanOrEqual(2)
    expect(file.lists).toEqual([...SEED_MODEL_LISTS])
    expect(file.lists[0]).toEqual({
      id: ZERO_COST_LIST_ID,
      label: "Zero-cost models",
      include: [{ kind: "tag", value: "price:zero" }],
    })
    expect(file.lists.map(l => l.id)).toEqual([ZERO_COST_LIST_ID, DEFAULT_ROTATION_LIST_ID])
    const mode = (await stat(modelListsPath())).mode & 0o777
    expect(mode).toBe(0o600)
    expect(JSON.parse(await readFile(modelListsPath(), "utf8"))).toMatchObject({
      version: 1,
    })
  })

  it("adds a missing seed to an existing file but never overwrites a user list", async () => {
    await mkdir(join(home, ".agentproto"), { recursive: true })
    await writeFile(
      modelListsPath(),
      JSON.stringify({
        version: 1,
        lists: [
          {
            id: DEFAULT_ROTATION_LIST_ID,
            label: "Mine",
            ids: ["acme/listed-model"],
          },
        ],
      }),
      "utf8",
    )
    const first = await loadModelLists()
    expect(first.lists.map(list => list.id).sort()).toEqual([
      DEFAULT_ROTATION_LIST_ID,
      ZERO_COST_LIST_ID,
    ])
    expect(first.lists.find(list => list.id === DEFAULT_ROTATION_LIST_ID)).toEqual({
      id: DEFAULT_ROTATION_LIST_ID,
      label: "Mine",
      ids: ["acme/listed-model"],
    })

    // A second load does not duplicate the seed it just added.
    const second = await loadModelLists()
    expect(second.lists.filter(list => list.id === ZERO_COST_LIST_ID)).toHaveLength(1)
    expect(second.lists).toHaveLength(2)
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

  it("refuses to delete seed lists and to edit the zero-cost entitlement list", async () => {
    await expect(deleteModelList(ZERO_COST_LIST_ID)).rejects.toThrow(/built-in seed/)
    await expect(deleteModelList(DEFAULT_ROTATION_LIST_ID)).rejects.toThrow(/built-in seed/)
    await expect(
      saveModelList({ id: ZERO_COST_LIST_ID, label: "Edited", ids: ["custom/model"] }),
    ).rejects.toThrow(/built-in and cannot be edited/)
    expect((await loadModelLists()).lists.find(list => list.id === ZERO_COST_LIST_ID)).toEqual({
      id: ZERO_COST_LIST_ID,
      label: "Zero-cost models",
      include: [{ kind: "tag", value: "price:zero" }],
    })
  })

  it("still allows editing the default-rotation seed", async () => {
    await saveModelList({ id: DEFAULT_ROTATION_LIST_ID, label: "Edited", ids: ["custom/model"] })
    expect(
      (await loadModelLists()).lists.find(list => list.id === DEFAULT_ROTATION_LIST_ID),
    ).toEqual({
      id: DEFAULT_ROTATION_LIST_ID,
      label: "Edited",
      ids: ["custom/model"],
    })
  })

  it("ignores a tampered zero-cost definition in the file and restores the seed", async () => {
    await mkdir(join(home, ".agentproto"), { recursive: true })
    await writeFile(
      modelListsPath(),
      JSON.stringify({
        version: 1,
        lists: [
          { id: ZERO_COST_LIST_ID, ids: ["acme/paid-model"] },
          { id: "pinned", ids: ["custom/model"] },
        ],
      }),
      "utf8",
    )

    const file = await loadModelLists()
    expect(file.lists.find(list => list.id === ZERO_COST_LIST_ID)).toEqual({
      id: ZERO_COST_LIST_ID,
      label: "Zero-cost models",
      include: [{ kind: "tag", value: "price:zero" }],
    })
    const source = modelListSourceFromLists(file.lists)
    expect(inModelList("acme/paid-model", ZERO_COST_LIST_ID, source)).toBe(false)
    expect(source.get("pinned")).toEqual({ id: "pinned", ids: ["custom/model"] })
  })

  it("refuses to delete a list another list references", async () => {
    await saveModelList({ id: "base", ids: ["custom/a"] })
    await saveModelList({
      id: "composite",
      include: [{ kind: "list", id: "base" }],
    })

    await expect(deleteModelList("base")).rejects.toThrow(
      /referenced by "composite"/,
    )
    expect(await deleteModelList("composite")).toBe(true)
    expect(await deleteModelList("base")).toBe(true)
  })

  it("fails closed when a list is missing or cyclic instead of throwing", () => {
    expect(isInModelList("big-pickle", "missing")).toBe(false)
    expect(
      isInModelList(
        "big-pickle",
        "a",
        modelListSourceFromLists([
          { id: "a", include: [{ kind: "list", id: "b" }] },
          { id: "b", include: [{ kind: "list", id: "a" }] },
        ]),
      ),
    ).toBe(false)
  })

  it("falls back to the seed definition when a seed id is missing from the file", () => {
    const source = modelListSourceFromLists([{ id: "custom", ids: ["a/b"] }])
    expect(source.get(ZERO_COST_LIST_ID)).toMatchObject({
      id: ZERO_COST_LIST_ID,
      include: [{ kind: "tag", value: "price:zero" }],
    })
    expect(source.get(DEFAULT_ROTATION_LIST_ID)).toMatchObject({
      id: DEFAULT_ROTATION_LIST_ID,
    })
  })
})
