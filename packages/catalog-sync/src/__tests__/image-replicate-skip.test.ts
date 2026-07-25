/**
 * Regression test: `--refresh` must never crash when REPLICATE_API_TOKEN is
 * unset. `REPLICATE_SOURCE` carries an `env:REPLICATE_API_TOKEN` auth header;
 * when that env var is missing, the runner's missing-env gate must reuse the
 * committed snapshot instead of issuing an unauthenticated fetch (which would
 * 401 and crash the whole `catalog-sync generate --refresh` run).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { imageReplicate, REPLICATE_SOURCE } from "../generators/image-replicate.js"
import { runGenerators } from "../runner.js"

describe("image:replicate — missing REPLICATE_API_TOKEN skip", () => {
  const originalToken = process.env["REPLICATE_API_TOKEN"]
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    delete process.env["REPLICATE_API_TOKEN"]
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network should never be hit when the token is missing")
    })
  })

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env["REPLICATE_API_TOKEN"]
    } else {
      process.env["REPLICATE_API_TOKEN"] = originalToken
    }
    fetchSpy.mockRestore()
  })

  it("declares an env-templated Authorization header", () => {
    expect(REPLICATE_SOURCE.headers).toEqual({
      Authorization: "Bearer env:REPLICATE_API_TOKEN",
    })
  })

  it("--refresh reuses the committed snapshot instead of throwing or fetching", async () => {
    const { files } = await runGenerators([imageReplicate], {
      refresh: true,
      write: false,
    })
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
