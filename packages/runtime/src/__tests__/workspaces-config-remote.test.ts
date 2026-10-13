/**
 * Workspace `remote` — schema validation, lenient disk normalisation, and the
 * pure set/unset helpers. Hermetic: a temp dir stands in for ~/.agentproto.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  addWorkspace,
  loadWorkspacesConfig,
  saveWorkspacesConfig,
  setWorkspaceRemote,
  unsetWorkspaceRemote,
  validateRemoteBranch,
  validateRemoteUrl,
  type WorkspacesConfig,
} from "../workspaces-config.js"

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agp-ws-remote-"))
  path = join(dir, "workspaces.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function baseConfig(): WorkspacesConfig {
  return addWorkspace({ version: 1, workspaces: [] }, { slug: "agentproto", path: "/tmp/agentproto" })
}

describe("validateRemoteUrl", () => {
  it("accepts a plain https URL and trims it", () => {
    expect(validateRemoteUrl("  https://github.com/acme/repo.git ")).toBe("https://github.com/acme/repo.git")
  })

  it.each([
    ["git@github.com:acme/repo.git", /not a valid URL/],
    ["ssh://git@github.com/acme/repo.git", /https/],
    ["http://github.com/acme/repo.git", /https/],
    ["file:///tmp/repo", /https/],
    ["https://x-access-token:ghp_fake@github.com/acme/repo.git", /must not embed credentials/],
    ["https://user@github.com/acme/repo.git", /must not embed credentials/],
    ["https://github.com/acme/repo.git?token=abc", /query string/],
    ["https://github.com/acme/repo.git#frag", /query string/],
    ["", /not a valid URL/],
  ])("rejects %s", (url, message) => {
    expect(() => validateRemoteUrl(url)).toThrow(message)
  })

  it("never echoes embedded credentials back in the error", () => {
    let message = ""
    try {
      validateRemoteUrl("https://x-access-token:ghp_fake_secret@github.com/acme/repo.git")
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toContain("ghp_fake_secret")
  })
})

describe("validateRemoteBranch", () => {
  it("accepts ordinary branch names", () => {
    for (const b of ["main", "release/1.2", "feat_x-y.z"]) expect(validateRemoteBranch(b)).toBe(b)
  })

  it.each(["", "-rf", "a b", "a;rm -rf /", "a..b", "x/", "x.lock", "$(id)", "a`b`"])("rejects %j", b => {
    expect(() => validateRemoteBranch(b)).toThrow(/branch/)
  })
})

describe("setWorkspaceRemote / unsetWorkspaceRemote", () => {
  it("attaches a validated remote and bumps updatedAt, leaving other fields", () => {
    const before = baseConfig()
    const next = setWorkspaceRemote(before, "agentproto", {
      url: "https://github.com/acme/repo.git",
      defaultBranch: "develop",
      credentialRef: "agentproto.git.agentproto",
    })
    const ws = next.workspaces[0]!
    expect(ws.remote).toEqual({
      url: "https://github.com/acme/repo.git",
      defaultBranch: "develop",
      credentialRef: "agentproto.git.agentproto",
    })
    expect(ws.path).toBe("/tmp/agentproto")
    expect(before.workspaces[0]!.remote).toBeUndefined()
  })

  it("throws for an unknown workspace and for an invalid remote", () => {
    expect(() => setWorkspaceRemote(baseConfig(), "nope", { url: "https://h/r.git" })).toThrow(/no workspace/)
    expect(() => setWorkspaceRemote(baseConfig(), "agentproto", { url: "http://h/r.git" })).toThrow(/https/)
    expect(() =>
      setWorkspaceRemote(baseConfig(), "agentproto", { url: "https://h/r.git", credentialRef: "a b" }),
    ).toThrow(/credentialRef/)
  })

  it("unset removes the remote; a second unset is a no-op", () => {
    const withRemote = setWorkspaceRemote(baseConfig(), "agentproto", { url: "https://h/r.git" })
    const cleared = unsetWorkspaceRemote(withRemote, "agentproto")
    expect(cleared.workspaces[0]!.remote).toBeUndefined()
    expect(unsetWorkspaceRemote(cleared, "agentproto")).toBe(cleared)
    expect(() => unsetWorkspaceRemote(cleared, "nope")).toThrow(/no workspace/)
  })

  it("survives re-adding the same workspace (path/label edits keep the remote)", () => {
    const withRemote = setWorkspaceRemote(baseConfig(), "agentproto", { url: "https://h/r.git" })
    const readded = addWorkspace(withRemote, { slug: "agentproto", path: "/tmp/elsewhere", label: "L" })
    expect(readded.workspaces[0]!.remote?.url).toBe("https://h/r.git")
  })
})

describe("persistence", () => {
  it("round-trips the remote through save/load", async () => {
    const cfg = setWorkspaceRemote(baseConfig(), "agentproto", {
      url: "https://github.com/acme/repo.git",
      defaultBranch: "main",
    })
    await saveWorkspacesConfig(cfg, path)
    const loaded = await loadWorkspacesConfig(path)
    expect(loaded.workspaces[0]!.remote).toEqual({
      url: "https://github.com/acme/repo.git",
      defaultBranch: "main",
    })
    const onDisk = JSON.parse(await readFile(path, "utf8")) as WorkspacesConfig
    expect(onDisk.workspaces[0]!.remote?.url).toBe("https://github.com/acme/repo.git")
  })

  it("drops a hand-edited invalid remote instead of failing the whole file", async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        workspaces: [
          { slug: "a", path: "/tmp/a", remote: { url: "git@github.com:acme/a.git" } },
          { slug: "b", path: "/tmp/b", remote: { url: "https://user:tok@github.com/acme/b.git" } },
          { slug: "c", path: "/tmp/c", remote: { url: "https://github.com/acme/c.git", defaultBranch: "x y" } },
          { slug: "d", path: "/tmp/d", remote: { url: "https://github.com/acme/d.git" } },
          { slug: "e", path: "/tmp/e", remote: "https://github.com/acme/e.git" },
        ],
      }),
    )
    const loaded = await loadWorkspacesConfig(path)
    expect(loaded.workspaces.map(w => [w.slug, w.remote?.url])).toEqual([
      ["a", undefined],
      ["b", undefined],
      ["c", undefined],
      ["d", "https://github.com/acme/d.git"],
      ["e", undefined],
    ])
  })
})
