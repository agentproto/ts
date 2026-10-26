/**
 * The `defaults.reactions.clerk.workspaces` key and its per-call reader.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import { loadConfig } from "../config.js"
import {
  findConfigKey,
  validateConfig,
  validateConfigKeyType,
} from "../config-schema.js"

vi.mock("../config.js", () => ({ loadConfig: vi.fn() }))

import { readClerkReactionOwnedWorkspaces } from "../action-hooks/clerk-reaction.js"

const loadConfigMock = vi.mocked(loadConfig)

beforeEach(() => {
  loadConfigMock.mockReset()
})

describe("defaults.reactions.clerk.workspaces config key", () => {
  it("is registered as a hot, writable defaults key with an empty default", () => {
    expect(findConfigKey("defaults.reactions.clerk.workspaces")).toMatchObject({
      apply: "hot",
      writable: true,
      section: "defaults",
      default: [],
    })
  })

  it("accepts a string array", () => {
    expect(validateConfigKeyType("defaults.reactions.clerk.workspaces", ["ws-a", "ws-b"])).toEqual({
      ok: true,
    })
    expect(
      validateConfig({
        defaults: { reactions: { clerk: { workspaces: ["ws-a", "ws-b"] } } },
      }).ok,
    ).toBe(true)
  })

  it("rejects an empty string slug", () => {
    const result = validateConfigKeyType("defaults.reactions.clerk.workspaces", ["ws-a", ""])
    expect(result.ok).toBe(false)
  })
})

describe("readClerkReactionOwnedWorkspaces", () => {
  it("returns the configured list", async () => {
    loadConfigMock.mockResolvedValue({
      defaults: { reactions: { clerk: { workspaces: ["ws-a", "ws-b"] } } },
    })
    expect(await readClerkReactionOwnedWorkspaces()).toEqual(["ws-a", "ws-b"])
  })

  it("returns an empty list when the key is absent", async () => {
    loadConfigMock.mockResolvedValue({})
    expect(await readClerkReactionOwnedWorkspaces()).toEqual([])
  })

  it("returns an empty list on a config error", async () => {
    loadConfigMock.mockRejectedValue(new Error("config exploded"))
    expect(await readClerkReactionOwnedWorkspaces()).toEqual([])
  })
})
