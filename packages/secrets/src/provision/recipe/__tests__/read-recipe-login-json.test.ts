/**
 * `readRecipeLoginJson` (provision/recipe/resolve.ts) — the box-login bridge's
 * raw input: the WHOLE login-file document a recipe's method points at, unlike
 * `resolveSourceSpec` which extracts one credential field via `jsonPath`.
 *
 * Sources are FAKE recipes registered against temp files; nothing here reads a
 * real `~/.codex/auth.json`.
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineProvisionRecipe, registerRecipe, readRecipeLoginJson } from "../index.js"

const dir = mkdtempSync(join(tmpdir(), "recipe-login-json-"))
const FILE_A = join(dir, "a-auth.json")
const FILE_B = join(dir, "b-auth.json")
const DOC_A = '{"tokens":{"access_token":"at-a"},"other":1}'
const DOC_B = '{"tokens":{"access_token":"at-b"},"other":2}'

beforeAll(() => {
  writeFileSync(FILE_A, DOC_A)
  writeFileSync(FILE_B, DOC_B)

  registerRecipe(
    defineProvisionRecipe({
      id: "test-login-file",
      description: "fake login file recipe",
      methods: [
        // `jsonPath` is deliberately present and must be IGNORED: the bridge
        // wants the document the CLI itself parses.
        { id: "surface-a", source: { file: FILE_A, jsonPath: "tokens.access_token" } },
        { id: "surface-b", source: { file: FILE_B } },
      ],
    }),
  )

  registerRecipe(
    defineProvisionRecipe({
      id: "test-login-chain",
      description: "fake chain: env first, file second",
      methods: [
        {
          id: "default",
          source: [{ env: "TEST_LOGIN_CHAIN_TOKEN" }, { file: FILE_A }],
        },
      ],
    }),
  )

  registerRecipe(
    defineProvisionRecipe({
      id: "test-login-env-only",
      description: "fake recipe with no file source at all",
      methods: [{ id: "default", source: { env: "TEST_LOGIN_ENV_ONLY_TOKEN" } }],
    }),
  )

  registerRecipe(
    defineProvisionRecipe({
      id: "test-login-missing",
      description: "fake recipe pointing at a file that does not exist",
      methods: [{ id: "default", source: { file: join(dir, "nope.json") } }],
    }),
  )
})

describe("readRecipeLoginJson", () => {
  it("returns the recipe source's WHOLE JSON, ignoring its jsonPath", async () => {
    await expect(readRecipeLoginJson("test-login-file", "surface-a")).resolves.toBe(DOC_A)
  })

  it("selects the method named by methodId", async () => {
    await expect(readRecipeLoginJson("test-login-file", "surface-b")).resolves.toBe(DOC_B)
  })

  it("defaults to the recipe's first method when methodId is omitted", async () => {
    await expect(readRecipeLoginJson("test-login-file")).resolves.toBe(DOC_A)
  })

  it("skips non-file sources and falls through the chain", async () => {
    // The env source is deliberately unset: it is skipped (a bare credential
    // is not a login document) and the file source wins.
    delete process.env.TEST_LOGIN_CHAIN_TOKEN
    await expect(readRecipeLoginJson("test-login-chain")).resolves.toBe(DOC_A)
  })

  it("fails loudly when no source is a file", async () => {
    await expect(readRecipeLoginJson("test-login-env-only")).rejects.toThrow(
      /only env\/prompt sources declared/,
    )
  })

  it("fails loudly when the login file is missing, naming the recipe not the value", async () => {
    const err = await readRecipeLoginJson("test-login-missing").catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("test-login-missing")
    expect(err.message).not.toContain("at-a")
  })

  it("fails loudly for an unknown recipe", async () => {
    await expect(readRecipeLoginJson("test-login-file", "nope")).rejects.toThrow()
  })
})
