/**
 * `loadAppBundledTools` — the AIP-14/30 TOOL.md/DRIVER.md loader for an
 * app's `.agentproto/tools/<id>/TOOL.md` + `.agentproto/drivers/<id>/DRIVER.md`
 * bundle directories (BRIEF-D). Covers: cli/http dispatch actually runs,
 * unsupported kinds load-but-refuse, missing secrets fail at dispatch (not
 * load), and malformed bundles fail loud naming the file path.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { loadAppBundledTools } from "../load-app-tools.js"
import { AppLoadError } from "../errors.js"

async function writeManifest(path: string, data: Record<string, unknown>, body = ""): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, matter.stringify(body, data), "utf8")
}

function toolManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: "agentproto/tool/v1",
    id: "greet",
    name: "Greet",
    description: "Greets a name.",
    version: "1.0.0",
    inputs: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    },
    outputs: {
      type: "object",
      required: ["greeting"],
      properties: { greeting: { type: "string" } },
    },
    ...overrides,
  }
}

function cliDriverManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: "agentproto/driver/v1",
    id: "greet-cli",
    name: "Greet CLI Driver",
    description: "Greets via node -e.",
    version: "1.0.0",
    kind: "cli",
    implements: [
      {
        tool: "greet",
        version: "*",
        metadata: {
          cli: {
            argv: [
              "-e",
              "console.log(JSON.stringify({greeting: 'hello, ' + process.argv[1]}))",
              "${input.name}",
            ],
            outputFormat: "json",
          },
        },
      },
    ],
    metadata: { cli: { bin: process.execPath } },
    ...overrides,
  }
}

function cwdToolManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: "agentproto/tool/v1",
    id: "report-cwd",
    name: "Report cwd",
    description: "Returns process.cwd().",
    version: "1.0.0",
    inputs: { type: "object", properties: {} },
    outputs: {
      type: "object",
      required: ["cwd"],
      properties: { cwd: { type: "string" } },
    },
    ...overrides,
  }
}

function cwdDriverManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: "agentproto/driver/v1",
    id: "report-cwd-cli",
    name: "Report cwd CLI Driver",
    description: "Reports process.cwd() via node -e.",
    version: "1.0.0",
    kind: "cli",
    implements: [
      {
        tool: "report-cwd",
        version: "*",
        metadata: {
          cli: {
            argv: ["-e", "process.stdout.write(JSON.stringify({cwd: process.cwd()}))"],
            outputFormat: "json",
          },
        },
      },
    ],
    metadata: { cli: { bin: process.execPath } },
    ...overrides,
  }
}

describe("loadAppBundledTools", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-kit-tools-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns empty arrays when the app ships no tools/drivers directory at all", async () => {
    const result = await loadAppBundledTools(dir)
    expect(result).toEqual({ tools: [], drivers: [] })
  })

  it("loads a TOOL.md into a manifest-only ToolHandle with its JSON Schema IO", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "greet", "TOOL.md"), toolManifest())
    const { tools } = await loadAppBundledTools(dir)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.id).toBe("greet")
    expect(tools[0]!.inputs).toMatchObject({ required: ["name"] })
  })

  it("loads a kind:cli DRIVER.md whose execute actually spawns the declared binary", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "greet", "TOOL.md"), toolManifest())
    await writeManifest(join(dir, ".agentproto", "drivers", "greet-cli", "DRIVER.md"), cliDriverManifest())

    const { drivers } = await loadAppBundledTools(dir)
    expect(drivers).toHaveLength(1)
    const driver = drivers[0]!
    expect(driver.kind).toBe("cli")

    const controller = new AbortController()
    const output = await driver.execute.greet!({
      input: { name: "World" },
      context: {},
      driverCtx: { secrets: {}, authState: "authed" },
      signal: controller.signal,
    })
    expect(output).toEqual({ greeting: "hello, World" })
  })

  it("a kind:cli driver's subprocess cwd defaults to the app root", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "report-cwd", "TOOL.md"), cwdToolManifest())
    await writeManifest(
      join(dir, ".agentproto", "drivers", "report-cwd-cli", "DRIVER.md"),
      cwdDriverManifest(),
    )

    const { drivers } = await loadAppBundledTools(dir)
    const output = await drivers[0]!.execute["report-cwd"]!({
      input: {},
      context: {},
      driverCtx: { secrets: {}, authState: "authed" },
      signal: new AbortController().signal,
    })
    expect(output).toEqual({ cwd: await realpath(dir) })
  })

  it("metadata.cli.cwd resolves relative to the app root", async () => {
    await mkdir(join(dir, "sub"), { recursive: true })
    await writeManifest(join(dir, ".agentproto", "tools", "report-cwd", "TOOL.md"), cwdToolManifest())
    await writeManifest(
      join(dir, ".agentproto", "drivers", "report-cwd-cli", "DRIVER.md"),
      cwdDriverManifest({ metadata: { cli: { bin: process.execPath, cwd: "sub" } } }),
    )

    const { drivers } = await loadAppBundledTools(dir)
    const output = await drivers[0]!.execute["report-cwd"]!({
      input: {},
      context: {},
      driverCtx: { secrets: {}, authState: "authed" },
      signal: new AbortController().signal,
    })
    expect(output).toEqual({ cwd: await realpath(join(dir, "sub")) })
  })

  it("metadata.cli.cwd escaping the app root fails the load, naming the driver", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "report-cwd", "TOOL.md"), cwdToolManifest())
    await writeManifest(
      join(dir, ".agentproto", "drivers", "report-cwd-cli", "DRIVER.md"),
      cwdDriverManifest({ metadata: { cli: { bin: process.execPath, cwd: "../.." } } }),
    )

    await expect(loadAppBundledTools(dir)).rejects.toThrow(AppLoadError)
    await expect(loadAppBundledTools(dir)).rejects.toThrow(/report-cwd-cli.*outside the app root/s)
  })

  it("loads a kind:http DRIVER.md that dispatches via fetch", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "greet", "TOOL.md"), toolManifest())
    await writeManifest(
      join(dir, ".agentproto", "drivers", "greet-http", "DRIVER.md"),
      {
        schema: "agentproto/driver/v1",
        id: "greet-http",
        name: "Greet HTTP Driver",
        description: "Greets via HTTP.",
        version: "1.0.0",
        kind: "http",
        implements: [
          {
            tool: "greet",
            version: "*",
            metadata: { http: { endpoint: "/greet", method: "POST" } },
          },
        ],
        metadata: { http: { baseUrl: "https://example.invalid" } },
      },
    )

    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ greeting: "hi from http" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof globalThis.fetch
    globalThis.fetch = fetchMock
    try {
      const { drivers } = await loadAppBundledTools(dir)
      const driver = drivers[0]!
      const controller = new AbortController()
      const output = await driver.execute.greet!({
        input: { name: "World" },
        context: {},
        driverCtx: { secrets: {}, authState: "authed" },
        signal: controller.signal,
      })
      expect(output).toEqual({ greeting: "hi from http" })
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.invalid/greet",
        expect.objectContaining({ method: "POST" }),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("loads (but refuses at dispatch) a driver kind this host doesn't support yet", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "greet", "TOOL.md"), toolManifest())
    await writeManifest(join(dir, ".agentproto", "drivers", "greet-mcp", "DRIVER.md"), {
      schema: "agentproto/driver/v1",
      id: "greet-mcp",
      name: "Greet MCP Driver",
      description: "An MCP-kind driver — not dispatchable by this host yet.",
      version: "1.0.0",
      kind: "mcp",
      implements: [{ tool: "greet", version: "*" }],
    })

    const { drivers } = await loadAppBundledTools(dir)
    expect(drivers).toHaveLength(1)
    await expect(
      drivers[0]!.execute.greet!({
        input: { name: "World" },
        context: {},
        driverCtx: { secrets: {}, authState: "authed" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/kind 'mcp' is not supported by this host/)
  })

  it("a declared secret missing from the environment fails at dispatch, naming the secret", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "greet", "TOOL.md"), toolManifest())
    await writeManifest(
      join(dir, ".agentproto", "drivers", "greet-cli", "DRIVER.md"),
      cliDriverManifest({ auth: { state: { env: ["BRIEF_D_TEST_MISSING_SECRET"] } } }),
    )
    delete process.env.BRIEF_D_TEST_MISSING_SECRET

    const { drivers } = await loadAppBundledTools(dir)
    await expect(
      drivers[0]!.execute.greet!({
        input: { name: "World" },
        context: {},
        driverCtx: { secrets: {}, authState: "authed" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/missing required secret 'BRIEF_D_TEST_MISSING_SECRET'/)
  })

  it("a present declared secret resolves from process.env into driverCtx.secrets", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "greet", "TOOL.md"), toolManifest())
    await writeManifest(
      join(dir, ".agentproto", "drivers", "greet-cli", "DRIVER.md"),
      cliDriverManifest({
        implements: [
          {
            tool: "greet",
            version: "*",
            metadata: {
              cli: {
                argv: [
                  "-e",
                  "console.log(JSON.stringify({greeting: process.env.BRIEF_D_TEST_SECRET + ' ' + process.argv[1]}))",
                  "${input.name}",
                ],
                outputFormat: "json",
              },
            },
          },
        ],
        auth: { state: { env: ["BRIEF_D_TEST_SECRET"] } },
        metadata: { cli: { bin: process.execPath, sandbox: { env: { pass: ["BRIEF_D_TEST_SECRET"] } } } },
      }),
    )
    process.env.BRIEF_D_TEST_SECRET = "shh"
    try {
      const { drivers } = await loadAppBundledTools(dir)
      const output = await drivers[0]!.execute.greet!({
        input: { name: "World" },
        context: {},
        driverCtx: { secrets: {}, authState: "authed" },
        signal: new AbortController().signal,
      })
      expect(output).toEqual({ greeting: "shh World" })
    } finally {
      delete process.env.BRIEF_D_TEST_SECRET
    }
  })

  it("a kind:cli DRIVER.md without 'metadata.cli.bin' fails the whole app load naming the file", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "greet", "TOOL.md"), toolManifest())
    const { metadata: _metadata, ...withoutBin } = cliDriverManifest()
    void _metadata
    await writeManifest(join(dir, ".agentproto", "drivers", "greet-cli", "DRIVER.md"), withoutBin)
    await expect(loadAppBundledTools(dir)).rejects.toThrow(AppLoadError)
    await expect(loadAppBundledTools(dir)).rejects.toThrow(/greet-cli.*DRIVER\.md/)
  })

  it("a TOOL.md id directory missing its TOOL.md file fails naming the path", async () => {
    await mkdir(join(dir, ".agentproto", "tools", "ghost"), { recursive: true })
    await expect(loadAppBundledTools(dir)).rejects.toThrow(AppLoadError)
    await expect(loadAppBundledTools(dir)).rejects.toThrow(/ghost.*TOOL\.md/)
  })

  it("malformed TOOL.md frontmatter fails naming the file path", async () => {
    await writeManifest(join(dir, ".agentproto", "tools", "greet", "TOOL.md"), { schema: "agentproto/tool/v1" })
    await expect(loadAppBundledTools(dir)).rejects.toThrow(AppLoadError)
  })
})
