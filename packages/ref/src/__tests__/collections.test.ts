import { describe, expect, it } from "vitest"
import {
  defineRef,
  listCollections,
  listKindsByCollection,
  refMatchesCollection,
} from "../index.js"

describe("collections — base assignments", () => {
  it("file collection covers all fetchable file-shaped kinds", () => {
    expect(listKindsByCollection("file")).toEqual([
      "git",
      "github",
      "ipfs",
      "local",
      "url",
    ])
  })

  it("identity collection covers all signer kinds", () => {
    expect(listKindsByCollection("identity")).toEqual([
      "email",
      "operator",
      "persona",
      "user",
    ])
  })

  it("anchor collection covers verifiable-witness kinds", () => {
    expect(listKindsByCollection("anchor")).toEqual(["eth_tx", "ots"])
  })

  it("chain collection narrows to on-chain anchor kinds", () => {
    expect(listKindsByCollection("chain")).toEqual(["eth_tx"])
  })

  it("listCollections returns the union of all in use", () => {
    const collections = listCollections()
    expect(collections).toEqual(
      expect.arrayContaining(["anchor", "chain", "file", "identity"])
    )
  })
})

describe("refMatchesCollection — runtime constraint", () => {
  it("an operator ref is in 'identity'", () => {
    const r = defineRef("operator:atlas")
    expect(refMatchesCollection(r.value, "identity")).toBe(true)
    expect(refMatchesCollection(r.value, "file")).toBe(false)
  })

  it("an eth_tx ref is in both 'anchor' and 'chain'", () => {
    const r = defineRef(
      "eth_tx:1:0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34"
    )
    expect(refMatchesCollection(r.value, "anchor")).toBe(true)
    expect(refMatchesCollection(r.value, "chain")).toBe(true)
    expect(refMatchesCollection(r.value, "identity")).toBe(false)
  })

  it("a github ref is in 'file'", () => {
    const r = defineRef("github:agentik/studio@main")
    expect(refMatchesCollection(r.value, "file")).toBe(true)
  })
})
