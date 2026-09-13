import { describe, expect, it } from "vitest"
import { isStaleRecord, PIPELINE_VERSION } from "../pipeline-version.js"

describe("isStaleRecord", () => {
  it("treats a record stamped with the current version as fresh", () => {
    expect(isStaleRecord({ pipelineVersion: PIPELINE_VERSION })).toBe(false)
  })

  it("treats a record stamped with an older version as stale", () => {
    expect(isStaleRecord({ pipelineVersion: PIPELINE_VERSION - 1 })).toBe(true)
  })

  it("treats a record with no pipelineVersion (pre-versioning data) as stale", () => {
    expect(isStaleRecord({})).toBe(true)
  })
})
