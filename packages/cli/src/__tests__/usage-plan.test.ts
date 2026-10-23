import { describe, expect, it } from "vitest"
import { countFreeLocalSessions } from "../commands/usage.js"

describe("countFreeLocalSessions", () => {
  it("counts alive local sessions on a free model", () => {
    const rows = [
      { id: "a", alive: true, model: "opencode/glm-5.3-flash-free" },
      { id: "b", alive: true, model: "opencode/deepseek-v4.1-flash-free" },
      { id: "c", alive: true, model: "opencode-go/glm-5.3" },
      { id: "d", alive: true, remote: true, model: "opencode/glm-5.3-flash-free" },
      { id: "e", alive: false, model: "opencode/glm-5.3-flash-free" },
      { id: "f", alive: true },
    ]
    // a+b count; c is paid, d is sandbox, e is dead, f has no model yet.
    expect(countFreeLocalSessions(rows)).toBe(2)
  })
})
