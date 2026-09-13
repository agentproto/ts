import { describe, it, expect } from "vitest"

import { slugify, titleCase } from "../slug.js"

describe("slugify", () => {
  it("lowercases and hyphenates non-alphanumeric runs", () => {
    expect(slugify("My Cool App")).toBe("my-cool-app")
    expect(slugify("weird__name!!v2")).toBe("weird-name-v2")
  })

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  --Leading and Trailing--  ")).toBe("leading-and-trailing")
  })

  it("falls back to 'app' when nothing alphanumeric survives", () => {
    expect(slugify("!!!")).toBe("app")
    expect(slugify("")).toBe("app")
  })
})

describe("titleCase", () => {
  it("capitalizes each hyphen-separated word", () => {
    expect(titleCase("my-cool-app")).toBe("My Cool App")
    expect(titleCase("app")).toBe("App")
  })
})
