/**
 * Tests for the ADDITIVE pagination surface of registerFsTools:
 *
 *   file_read      — offset/limit (LINES for utf8, BYTES for base64) + `truncated`
 *   directory_list — limit/cursor page-walk over the entries
 *
 * The defaults (no offset/limit/cursor) must remain byte-identical to the
 * pre-pagination behaviour: the WHOLE file / ALL entries, plain string
 * result — covered here and in fs-tools.test.ts.
 *
 * Runs fully in-process — no daemon needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { registerFsTools } from "../fs-tools.js"

/** Cast-free text extractor: `client.callTool` resolves to a union whose
 *  non-`content` variants (task results) simply yield "". */
function textOf(result: object): string {
  if (!("content" in result) || !Array.isArray(result.content)) return ""
  for (const block of result.content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text
    }
  }
  return ""
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fs-tools-pagination-test-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

async function makeSetup() {
  const server = new McpServer({ name: "test-fs-pagination", version: "0.0.1" })
  registerFsTools(server, { workspace: tmp })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)

  return { client, cleanup: async () => client.close() }
}

interface FileReadWindow {
  content: string
  truncated: boolean
  offset: number
  returned: number
  total: number
}

interface DirectoryPage {
  items: string[]
  nextCursor?: string
  total: number
}

describe("file_read — additive offset/limit (LINES, utf8)", () => {
  it("returns the whole file unchanged when no offset/limit is given", async () => {
    const { client, cleanup } = await makeSetup()
    writeFileSync(join(tmp, "text.txt"), "one\ntwo\nthree\nfour\n", "utf8")

    const result = await client.callTool({ name: "file_read", arguments: { path: "text.txt" } })
    expect(textOf(result)).toBe("one\ntwo\nthree\nfour\n")

    await cleanup()
  })

  it("windows by LINES with offset+limit and flags truncated", async () => {
    const { client, cleanup } = await makeSetup()
    const lines = ["l0", "l1", "l2", "l3", "l4", "l5"]
    writeFileSync(join(tmp, "text.txt"), lines.join("\n") + "\n", "utf8")

    const result = await client.callTool({
      name: "file_read",
      arguments: { path: "text.txt", offset: 2, limit: 2 },
    })
    const parsed: FileReadWindow = JSON.parse(textOf(result))
    expect(parsed.content).toBe("l2\nl3")
    expect(parsed.truncated).toBe(true)
    expect(parsed.offset).toBe(2)
    expect(parsed.returned).toBe(2)
    expect(parsed.total).toBe(7) // "l0..l5\n" splits into 7 (trailing empty line)
  })

  it("limit alone reads from the top; last window is not truncated", async () => {
    const { client, cleanup } = await makeSetup()
    writeFileSync(join(tmp, "text.txt"), "a\nb\nc", "utf8")

    const page1: FileReadWindow = JSON.parse(
      textOf(await client.callTool({ name: "file_read", arguments: { path: "text.txt", limit: 2 } })),
    )
    expect(page1.content).toBe("a\nb")
    expect(page1.truncated).toBe(true)

    const page2: FileReadWindow = JSON.parse(
      textOf(
        await client.callTool({
          name: "file_read",
          arguments: { path: "text.txt", offset: page1.offset + page1.returned },
        }),
      ),
    )
    expect(page2.content).toBe("c")
    expect(page2.truncated).toBe(false)

    await cleanup()
  })

  it("offset past EOF returns empty content, not an error", async () => {
    const { client, cleanup } = await makeSetup()
    writeFileSync(join(tmp, "text.txt"), "a\nb", "utf8")

    const parsed: FileReadWindow = JSON.parse(
      textOf(
        await client.callTool({
          name: "file_read",
          arguments: { path: "text.txt", offset: 99 },
        }),
      ),
    )
    expect(parsed.content).toBe("")
    expect(parsed.truncated).toBe(false)
    expect(parsed.offset).toBe(2)

    await cleanup()
  })
})

describe("file_read — additive offset/limit (BYTES, base64)", () => {
  it("windows by BYTES on the raw buffer, base64 round-trips the slice", async () => {
    const { client, cleanup } = await makeSetup()
    const body = Buffer.from("0123456789abcdef", "utf8")
    writeFileSync(join(tmp, "bin.dat"), body)

    const result = await client.callTool({
      name: "file_read",
      arguments: { path: "bin.dat", encoding: "base64", offset: 4, limit: 6 },
    })
    const parsed: FileReadWindow = JSON.parse(textOf(result))
    expect(parsed.truncated).toBe(true)
    expect(parsed.total).toBe(body.length)
    expect(Buffer.from(parsed.content, "base64").toString("utf8")).toBe("456789")

    await cleanup()
  })

  it("byte window to EOF is not truncated; default base64 read unchanged", async () => {
    const { client, cleanup } = await makeSetup()
    const body = Buffer.from([0, 1, 2, 3, 4, 5])
    writeFileSync(join(tmp, "bin.dat"), body)

    const tail: FileReadWindow = JSON.parse(
      textOf(
        await client.callTool({
          name: "file_read",
          arguments: { path: "bin.dat", encoding: "base64", offset: 4 },
        }),
      ),
    )
    expect(tail.truncated).toBe(false)
    expect(Buffer.from(tail.content, "base64").equals(body.subarray(4))).toBe(true)

    const full = textOf(
      await client.callTool({ name: "file_read", arguments: { path: "bin.dat", encoding: "base64" } }),
    )
    expect(Buffer.from(full, "base64").equals(body)).toBe(true)

    await cleanup()
  })
})

describe("directory_list — additive limit/cursor page-walk", () => {
  it("returns ALL entries as one plain string when no limit/cursor is given", async () => {
    const { client, cleanup } = await makeSetup()
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(join(tmp, name), "x", "utf8")
    }

    const result = await client.callTool({ name: "directory_list", arguments: {} })
    const text = textOf(result)
    expect(text.split("\n").sort()).toEqual(["[FILE] a.txt", "[FILE] b.txt", "[FILE] c.txt"].sort())

    await cleanup()
  })

  it("page-walk with limit/cursor yields exactly the full listing (union == full)", async () => {
    const { client, cleanup } = await makeSetup()
    const names = ["f0", "f1", "f2", "f3", "f4", "f5", "f6"]
    for (const name of names) {
      writeFileSync(join(tmp, `${name}.txt`), "x", "utf8")
    }

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = await client.callTool({
        name: "directory_list",
        arguments: { limit: 3, ...(cursor !== undefined ? { cursor } : {}) },
      })
      const parsed: DirectoryPage = JSON.parse(textOf(result))
      seen.push(...parsed.items)
      if (parsed.nextCursor === undefined) break
      cursor = parsed.nextCursor
    }

    expect(seen).toHaveLength(names.length)
    expect(seen.map(l => l.replace("[FILE] ", "").replace(".txt", "")).sort()).toEqual(
      [...names].sort(),
    )
    expect(new Set(seen).size).toBe(names.length)

    await cleanup()
  })

  it("reports total and omits nextCursor on the final page", async () => {
    const { client, cleanup } = await makeSetup()
    writeFileSync(join(tmp, "only.txt"), "x", "utf8")

    const parsed: DirectoryPage = JSON.parse(
      textOf(await client.callTool({ name: "directory_list", arguments: { limit: 10 } })),
    )
    expect(parsed.items).toEqual(["[FILE] only.txt"])
    expect(parsed.total).toBe(1)
    expect(parsed.nextCursor).toBeUndefined()

    await cleanup()
  })
})
