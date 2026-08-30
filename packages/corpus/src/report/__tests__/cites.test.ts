import { describe, it, expect } from "vitest"
import { citesOf, outOfRangeCites } from "../cites.js"

describe("citesOf", () => {
  it("counts a prose citation", () => {
    expect(citesOf("See the results [3] for details.")).toEqual([3])
  })

  it("ignores array-index brackets inside a fenced code block", () => {
    const s = "Prose [1].\n\n```js\nconst x = weather[0];\nconst y = arr[12];\n```\n\nMore prose [2]."
    expect(citesOf(s)).toEqual([1, 2])
  })

  it("ignores array-index brackets inside an inline code span", () => {
    const s = "Access it via `x[12]` to get the value, per [3]."
    expect(citesOf(s)).toEqual([3])
  })

  it("does not flag out-of-range cites from code-only array indexing", () => {
    const s = "```js\nconst weather = data[0];\nconst arr = list[12];\n```"
    expect(outOfRangeCites(s, 5)).toEqual([])
  })

  it("still flags an out-of-range prose citation", () => {
    expect(outOfRangeCites("Bad cite [9].", 5)).toEqual([9])
  })

  it("does not read a [n](url) markdown link as a citation", () => {
    expect(citesOf("See [3](https://example.com) for more, and [4] itself.")).toEqual([4])
  })
})
