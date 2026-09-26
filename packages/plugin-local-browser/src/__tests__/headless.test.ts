import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildHeadlessBrowserMcpEntry,
  CHROME_PATH_ENV,
  ensureChromeDevtoolsMcp,
  findChrome,
  findHeadlessShell,
  headlessBrowserReadPaths,
  readChromeDevtoolsMcp,
  resetChromeDevtoolsMcpCache,
} from "../headless.js"

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

describe("buildHeadlessBrowserMcpEntry", () => {
  const mcp = { entryScript: "/p/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js" }

  it("builds an isolated headless stdio entry run by node, 1440x900 by default", () => {
    const entry = buildHeadlessBrowserMcpEntry({ mcp, node: "/usr/bin/node" })
    expect(entry).toEqual({
      name: "browser",
      transport: "stdio",
      ref: "/usr/bin/node",
      args: [
        mcp.entryScript,
        "--headless",
        "--isolated",
        "--viewport",
        "1440x900",
        "--no-category-performance",
        "--no-performance-crux",
        "--no-usage-statistics",
        "--no-page-id-routing",
      ],
      env: {
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
      },
    })
  })

  it("defaults the runner to the current node binary", () => {
    expect(buildHeadlessBrowserMcpEntry({ mcp }).ref).toBe(process.execPath)
  })

  it("adds executablePath, --no-sandbox, extra chrome args and a log file", () => {
    const { args } = buildHeadlessBrowserMcpEntry({
      mcp,
      executablePath: MAC_CHROME,
      viewport: "800x600",
      chromeSandbox: false,
      chromeArgs: ["--agentproto-session=s1"],
      logFile: "/tmp/b.log",
      filesystemRoots: ["/ws", "/tmp"],
    })
    expect(args.join(" ")).toContain("--workspace /ws --workspace /tmp")
    expect(args).toContain("800x600")
    expect(args.slice(args.indexOf("--executablePath"), args.indexOf("--executablePath") + 2)).toEqual([
      "--executablePath",
      MAC_CHROME,
    ])
    expect(args).toContain("--chromeArg=--no-sandbox")
    expect(args).toContain("--chromeArg=--agentproto-session=s1")
    expect(args.slice(-2)).toEqual(["--logFile", "/tmp/b.log"])
  })

  it("uses a caller-owned profile dir instead of --isolated when given", () => {
    const { args } = buildHeadlessBrowserMcpEntry({ mcp, userDataDir: "/tmp/agentproto-browser/s1" })
    expect(args).not.toContain("--isolated")
    expect(args.slice(args.indexOf("--userDataDir"), args.indexOf("--userDataDir") + 2)).toEqual([
      "--userDataDir",
      "/tmp/agentproto-browser/s1",
    ])
  })

  it("rejects a malformed viewport", () => {
    expect(() => buildHeadlessBrowserMcpEntry({ mcp, viewport: "big" })).toThrow(/WIDTHxHEIGHT/)
  })
})

describe("findChrome", () => {
  const onlyExists = (...paths: string[]) => (p: string) => paths.includes(p)

  it("prefers AGENTPROTO_CHROME_PATH over everything", () => {
    expect(
      findChrome({
        platform: "darwin",
        env: { [CHROME_PATH_ENV]: "/custom/chrome" },
        exists: onlyExists("/custom/chrome", MAC_CHROME),
      }),
    ).toEqual({ path: "/custom/chrome", source: "env" })
  })

  it("returns null when the env override points nowhere (no silent fallback)", () => {
    expect(
      findChrome({ platform: "darwin", env: { [CHROME_PATH_ENV]: "/nope" }, exists: onlyExists(MAC_CHROME) }),
    ).toBeNull()
  })

  it("finds system Chrome on macOS", () => {
    expect(findChrome({ platform: "darwin", env: {}, home: "/Users/u", exists: onlyExists(MAC_CHROME) })).toEqual({
      path: MAC_CHROME,
      source: "system",
    })
  })

  it("finds google-chrome on Linux through PATH", () => {
    expect(
      findChrome({
        platform: "linux",
        env: { PATH: "/usr/local/bin:/usr/bin" },
        home: "/home/u",
        exists: onlyExists("/usr/bin/google-chrome"),
        readdir: () => [],
      }),
    ).toEqual({ path: "/usr/bin/google-chrome", source: "system" })
  })

  it("falls back to the newest downloaded chrome-headless-shell", () => {
    const dir = "/home/u/.agentproto/chrome-headless-shell"
    const newer = `${dir}/chrome-headless-shell/linux-131.0.6778.85/chrome-headless-shell-linux64/chrome-headless-shell`
    const older = `${dir}/chrome-headless-shell/linux-129.0.6668.100/chrome-headless-shell-linux64/chrome-headless-shell`
    expect(
      findChrome({
        platform: "linux",
        env: { PATH: "/usr/bin" },
        home: "/home/u",
        exists: onlyExists(newer, older),
        readdir: p => (p === `${dir}/chrome-headless-shell` ? ["linux-129.0.6668.100", "linux-131.0.6778.85"] : []),
      }),
    ).toEqual({ path: newer, source: "headless-shell" })
  })

  it("skips system Chrome when sources exclude it", () => {
    const shell = "/d/chrome-headless-shell/mac_arm-154.0.8037.57/chrome-headless-shell-mac-arm64/chrome-headless-shell"
    const opts = {
      platform: "darwin" as const,
      arch: "arm64",
      env: {},
      headlessShellDir: "/d",
      exists: (p: string) => p === MAC_CHROME || p === shell,
      readdir: () => ["mac_arm-154.0.8037.57"],
    }
    expect(findChrome(opts)?.source).toBe("system")
    expect(findChrome({ ...opts, sources: ["env", "headless-shell"] })).toEqual({ path: shell, source: "headless-shell" })
  })

  it("returns null when nothing is installed", () => {
    expect(findChrome({ platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false, readdir: () => [] })).toBeNull()
  })

  it("maps Apple-silicon macOS onto the mac_arm cache dir and mac-arm64 archive folder", () => {
    const shell = "/d/chrome-headless-shell/mac_arm-154.0.8037.57/chrome-headless-shell-mac-arm64/chrome-headless-shell"
    expect(
      findHeadlessShell("/d", {
        platform: "darwin",
        arch: "arm64",
        exists: p => p === shell,
        readdir: () => ["mac-154.0.8037.57", "mac_arm-154.0.8037.57"],
      }),
    ).toBe(shell)
  })

  it("ignores headless-shell builds for another platform", () => {
    expect(
      findHeadlessShell("/d", {
        platform: "darwin",
        arch: "arm64",
        exists: () => true,
        readdir: () => ["linux-131.0.6778.85", "mac-131.0.6778.85"],
      }),
    ).toBeNull()
  })
})

describe("headlessBrowserReadPaths", () => {
  it("grants the chrome-mcp prefix and the Chrome .app bundle", () => {
    expect(headlessBrowserReadPaths({ prefix: "/h/.agentproto/chrome-mcp" }, { path: MAC_CHROME })).toEqual([
      "/h/.agentproto/chrome-mcp",
      "/Applications/Google Chrome.app",
    ])
  })

  it("grants a non-bundle Chrome's directory", () => {
    expect(headlessBrowserReadPaths({ prefix: "/p" }, { path: "/opt/google/chrome/chrome" })).toEqual([
      "/p",
      "/opt/google/chrome",
    ])
  })
})

describe("ensureChromeDevtoolsMcp", () => {
  let prefix: string

  beforeEach(async () => {
    resetChromeDevtoolsMcpCache()
    prefix = await mkdtemp(join(tmpdir(), "chrome-mcp-"))
  })
  afterEach(async () => {
    await rm(prefix, { recursive: true, force: true })
  })

  async function fakeInstall(dir: string): Promise<void> {
    const pkgDir = join(dir, "node_modules", "chrome-devtools-mcp")
    await mkdir(join(pkgDir, "build", "src", "bin"), { recursive: true })
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ version: "1.2.3", bin: { "chrome-devtools-mcp": "./build/src/bin/chrome-devtools-mcp.js" } }),
    )
    await writeFile(join(pkgDir, "build", "src", "bin", "chrome-devtools-mcp.js"), "")
  }

  it("reuses an existing install without running npm", async () => {
    await fakeInstall(prefix)
    const got = await ensureChromeDevtoolsMcp({ prefix, npm: "/definitely/not/npm" })
    expect(got).toMatchObject({
      prefix,
      version: "1.2.3",
      installed: false,
      entryScript: join(prefix, "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js"),
    })
  })

  it("shares one in-flight resolution between concurrent callers", async () => {
    await fakeInstall(prefix)
    const a = ensureChromeDevtoolsMcp({ prefix })
    const b = ensureChromeDevtoolsMcp({ prefix })
    expect(a).toBe(b)
    await a
  })

  it("evicts a failed install so the next call retries", async () => {
    await expect(ensureChromeDevtoolsMcp({ prefix, npm: "/definitely/not/npm" })).rejects.toThrow()
    await fakeInstall(prefix)
    await expect(ensureChromeDevtoolsMcp({ prefix, npm: "/definitely/not/npm" })).resolves.toMatchObject({
      version: "1.2.3",
    })
  })

  it("readChromeDevtoolsMcp returns null for an empty prefix", async () => {
    expect(await readChromeDevtoolsMcp(prefix)).toBeNull()
  })
})
