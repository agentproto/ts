/**
 * Tests for registerFsTools' file_read encoding param.
 *
 * Regression: file_read used to always decode as UTF-8, which replaces
 * invalid byte sequences with U+FFFD — corrupting any binary file (a PNG's
 * 0x89 header byte, for instance). encoding: "base64" must round-trip
 * binary content byte-for-byte; the default stays "utf8" (unchanged).
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

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fs-tools-test-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

async function makeSetup() {
  const server = new McpServer({ name: "test-fs", version: "0.0.1" })
  registerFsTools(server, { workspace: tmp })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)

  const cleanup = async () => {
    await client.close()
  }

  return { client, cleanup }
}

function textOf(result: unknown): string {
  return (
    (result as { content: Array<{ type: string; text: string }> }).content[0]!.text
  )
}

describe("file_read — encoding", () => {
  it("defaults to utf8 (unchanged behavior)", async () => {
    const { client, cleanup } = await makeSetup()
    writeFileSync(join(tmp, "hello.txt"), "héllo world", "utf8")

    const result = await client.callTool({ name: "file_read", arguments: { path: "hello.txt" } })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe("héllo world")

    await cleanup()
  })

  it("explicit utf8 matches the default", async () => {
    const { client, cleanup } = await makeSetup()
    writeFileSync(join(tmp, "hello.txt"), "hello world", "utf8")

    const result = await client.callTool({
      name: "file_read",
      arguments: { path: "hello.txt", encoding: "utf8" },
    })
    expect(textOf(result)).toBe("hello world")

    await cleanup()
  })

  it("base64 round-trips binary content byte-for-byte", async () => {
    const { client, cleanup } = await makeSetup()
    // A minimal 1x1 PNG — real binary bytes including 0x89, which UTF-8
    // decoding mangles into U+FFFD (the exact corruption this fix prevents).
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAAA3NCSVQICAjb4U/gAAAADUlEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC",
      "base64",
    )
    writeFileSync(join(tmp, "pixel.png"), png)

    const result = await client.callTool({
      name: "file_read",
      arguments: { path: "pixel.png", encoding: "base64" },
    })
    expect(result.isError).toBeFalsy()
    const roundTripped = Buffer.from(textOf(result), "base64")
    expect(roundTripped.equals(png)).toBe(true)
    // The PNG signature bytes (0x89 'P' 'N' 'G' ...) survive intact.
    expect(roundTripped.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    await cleanup()
  })

  it("utf8 decoding of the same binary file corrupts the PNG signature (proves the bug the fix avoids)", async () => {
    const { client, cleanup } = await makeSetup()
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAAA3NCSVQICAjb4U/gAAAADUlEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC",
      "base64",
    )
    writeFileSync(join(tmp, "pixel.png"), png)

    const result = await client.callTool({ name: "file_read", arguments: { path: "pixel.png" } })
    const utf8Text = textOf(result)
    // 0x89 is not valid standalone UTF-8 — it round-trips as U+FFFD, not 0x89.
    expect(utf8Text.charCodeAt(0)).toBe(0xfffd)
    expect(Buffer.from(utf8Text, "utf8").subarray(0, 4)).not.toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )

    await cleanup()
  })
})
