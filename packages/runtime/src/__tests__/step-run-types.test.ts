import { describe, it, expect, vi, afterEach } from "vitest"
import { logRoutineRunnerDeprecation } from "../step-run-types.js"

describe("logRoutineRunnerDeprecation", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("emits a one-line DEPRECATED warning on first use of a given surface", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    logRoutineRunnerDeprecation("test_surface_unique_1")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("DEPRECATED")
    expect(warn.mock.calls[0]?.[0]).toContain("test_surface_unique_1")
  })

  it("logs only once per surface across repeated calls", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    logRoutineRunnerDeprecation("test_surface_unique_2")
    logRoutineRunnerDeprecation("test_surface_unique_2")
    logRoutineRunnerDeprecation("test_surface_unique_2")
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("logs independently per distinct surface", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    logRoutineRunnerDeprecation("test_surface_unique_3a")
    logRoutineRunnerDeprecation("test_surface_unique_3b")
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
