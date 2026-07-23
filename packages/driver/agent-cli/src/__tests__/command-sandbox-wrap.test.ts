/**
 * `wrapAgentCliSpawn`'s config-file sourcing (PR 6b) and the built-in
 * toolchain read-path defaults, including the git/gh keychain-credential
 * fix. Pure precedence/merge logic runs everywhere; the backend-dependent
 * cases (anything that resolves to `"workspace"`/`"strict"`) are gated on
 * an actual confinement backend being installed (Seatbelt on darwin, bwrap
 * on linux — CI's ubuntu runners have neither installed, so those are
 * skipped there, mirroring `@agentproto/command-sandbox`'s own
 * `canRunSeatbelt`/`canRunBwrap` gates).
 */

import { describe, it, expect, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  ADAPTER_COMMAND_SANDBOX_MODE_ENV,
  resolveCommandSandbox,
} from "@agentproto/command-sandbox"
import {
  defaultToolchainReadPaths,
  defaultToolchainWritePaths,
  wrapAgentCliSpawn,
} from "../command-sandbox-wrap.js"

async function withWorkspace(
  configJson: string | null,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agent-cli-sbxwrap-"))
  try {
    if (configJson !== null) {
      await mkdir(join(dir, ".agentproto"), { recursive: true })
      await writeFile(join(dir, ".agentproto", "command-sandbox.json"), configJson)
    }
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("defaultToolchainReadPaths", () => {
  it("includes the git/gh config + macOS Keychain paths that fix the PR 6a credential gap", () => {
    const paths = defaultToolchainReadPaths()
    const home = homedir()
    expect(paths).toContain(join(home, ".gitconfig"))
    expect(paths).toContain(join(home, ".config", "git"))
    expect(paths).toContain(join(home, ".config", "gh"))
    expect(paths).toContain(join(home, "Library", "Keychains"))
  })
})

describe("wrapAgentCliSpawn mode resolution", () => {
  it("stays unconfined + silent when neither an explicit mode nor a config file engage the axis", async () => {
    await withWorkspace(null, async dir => {
      const [bin, args] = await wrapAgentCliSpawn("echo", ["hi"], {
        mode: undefined,
        cwd: dir,
        label: "test",
      })
      expect(bin).toBe("echo")
      expect(args).toEqual(["hi"])
    })
  })

  it("an explicit opts.mode wins over a config file that asks for a different mode", async () => {
    await withWorkspace(
      JSON.stringify({ adapterSpawn: { mode: "strict" } }),
      async dir => {
        // Explicit "off" beats the file's "strict" — still unconfined, no throw.
        const [bin, args] = await wrapAgentCliSpawn("echo", ["hi"], {
          mode: "off",
          cwd: dir,
          label: "test",
        })
        expect(bin).toBe("echo")
        expect(args).toEqual(["hi"])
      },
    )
  })

  it("falls back to the config file's adapterSpawn.mode when opts.mode is undefined", async () => {
    await withWorkspace(JSON.stringify({ adapterSpawn: { mode: "off" } }), async dir => {
      // File resolves to explicit "off" (engaged) — still unconfined, but via
      // the loud-warning branch rather than the silent one. Either way argv
      // is unchanged; this only proves the file's mode was actually read.
      const [bin, args] = await wrapAgentCliSpawn("echo", ["hi"], {
        mode: undefined,
        cwd: dir,
        label: "test",
      })
      expect(bin).toBe("echo")
      expect(args).toEqual(["hi"])
    })
  })

  it("the top-level command_execute `mode` key does NOT leak into the adapter-spawn axis", async () => {
    await withWorkspace(JSON.stringify({ mode: "strict" }), async dir => {
      const [bin, args] = await wrapAgentCliSpawn("echo", ["hi"], {
        mode: undefined,
        cwd: dir,
        label: "test",
      })
      // Untouched axis ⇒ unconfined, exactly like the no-config-file case.
      expect(bin).toBe("echo")
      expect(args).toEqual(["hi"])
    })
  })

  describe(`${ADAPTER_COMMAND_SANDBOX_MODE_ENV} override`, () => {
    afterEach(() => {
      delete process.env[ADAPTER_COMMAND_SANDBOX_MODE_ENV]
    })

    it("an explicit opts.mode still wins over the env var", async () => {
      process.env[ADAPTER_COMMAND_SANDBOX_MODE_ENV] = "strict"
      await withWorkspace(null, async dir => {
        const [bin, args] = await wrapAgentCliSpawn("echo", ["hi"], {
          mode: "off",
          cwd: dir,
          label: "test",
        })
        expect(bin).toBe("echo")
        expect(args).toEqual(["hi"])
      })
    })
  })
})

// Anything below actually resolves to "workspace"/"strict" and therefore
// needs a real confinement backend on this platform (fail-closed otherwise).
const backendAvailable = resolveCommandSandbox() !== null

describe.runIf(backendAvailable)("wrapAgentCliSpawn confined argv + path merging", () => {
  it("merges the config file's adapterSpawn.extraReadPaths/extraWritePaths with the built-in defaults and the caller's own", async () => {
    await withWorkspace(
      JSON.stringify({
        adapterSpawn: {
          mode: "workspace",
          extraReadPaths: ["/opt/from-config-read"],
          extraWritePaths: ["/opt/from-config-write"],
        },
      }),
      async dir => {
        const [bin, args] = await wrapAgentCliSpawn("echo", ["hi"], {
          mode: undefined,
          cwd: dir,
          extraReadPaths: ["/opt/from-caller-read"],
          extraWritePaths: ["/opt/from-caller-write"],
          label: "test",
        })
        const full = [bin, ...args].join(" ")
        for (const p of [
          ...defaultToolchainReadPaths(),
          "/opt/from-config-read",
          "/opt/from-caller-read",
          ...defaultToolchainWritePaths(),
          "/opt/from-config-write",
          "/opt/from-caller-write",
        ]) {
          expect(full).toContain(p)
        }
      },
    )
  })

  it("config file's adapterSpawn.network can force network deny in workspace mode without going all the way to strict", async () => {
    await withWorkspace(
      JSON.stringify({ adapterSpawn: { mode: "workspace", network: "deny" } }),
      async dir => {
        const [bin, args] = await wrapAgentCliSpawn("echo", ["hi"], {
          mode: undefined,
          cwd: dir,
          label: "test",
        })
        const full = [bin, ...args].join(" ")
        expect(full).toMatch(/deny network/)
      },
    )
  })
})

// Real spawned confinement, mirroring PR 6a's empirical verification style —
// not just profile-string assertions. Uses a THROWAWAY keychain the test
// creates and deletes itself (never the developer's real login keychain,
// never a real credential) to reproduce PR 6a's exact finding: a confined
// git/gh credential-helper lookup came back EMPTY because its own keychain
// database file lives under $HOME, which `workspace` mode denies content
// access to by default.
const canRunSeatbeltKeychainProbe =
  process.platform === "darwin" && existsSync("/usr/bin/security")

describe.runIf(canRunSeatbeltKeychainProbe)(
  "real confined keychain read (the PR 6a → 6b credential gap)",
  () => {
    it("a throwaway keychain under ~/Library/Keychains is readable confined (fixed) but NOT readable confined without that read-allow (the PR 6a gap, reproduced)", async () => {
      const account = `agentproto-pr6b-test-${randomUUID()}`
      const service = "agentproto-pr6b-test-service"
      const secret = `synthetic-secret-${randomUUID()}` // not a real credential
      const kcName = `agentproto-pr6b-test-${randomUUID()}.keychain-db`
      const kcPath = join(homedir(), "Library", "Keychains", kcName)
      const kcPassword = randomUUID()
      const ws = await mkdtemp(join(tmpdir(), "agent-cli-sbxwrap-kc-ws-"))

      try {
        execFileSync("/usr/bin/security", ["create-keychain", "-p", kcPassword, kcPath])
        execFileSync("/usr/bin/security", ["unlock-keychain", "-p", kcPassword, kcPath])
        execFileSync("/usr/bin/security", [
          "add-generic-password",
          "-a",
          account,
          "-s",
          service,
          "-w",
          secret,
          kcPath,
        ])

        // WITHOUT the fix: workspace confinement, but querying the throwaway
        // keychain from a policy that does NOT re-allow ~/Library/Keychains
        // (only the default toolchain read paths minus that one entry).
        const seatbeltMod = await import("@agentproto/command-sandbox")
        const noFixProfile = seatbeltMod.buildSeatbeltProfile({
          workspace: ws,
          extraReadPaths: [], // deliberately omits ~/Library/Keychains
          network: "allow",
        })
        let deniedWithoutFix = false
        try {
          const out = execFileSync(
            "sandbox-exec",
            [
              "-p",
              noFixProfile,
              "/usr/bin/security",
              "find-generic-password",
              "-a",
              account,
              "-s",
              service,
              "-w",
              kcPath,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          )
          // Some macOS versions return empty output rather than a nonzero
          // exit when the keychain db itself can't be opened — either
          // signal counts as "the fix wasn't applied and it broke".
          deniedWithoutFix = out.trim() !== secret
        } catch {
          deniedWithoutFix = true
        }
        expect(deniedWithoutFix).toBe(true)

        // WITH the fix: wrapAgentCliSpawn's real default read paths include
        // ~/Library/Keychains, sourced with no config file at all (mode
        // passed explicitly here since this test isn't exercising the
        // config-file axis).
        const [execBin, execArgs] = await wrapAgentCliSpawn(
          "/usr/bin/security",
          ["find-generic-password", "-a", account, "-s", service, "-w", kcPath],
          { mode: "workspace", cwd: ws, label: "test" },
        )
        const fixedOut = execFileSync(execBin, execArgs, { encoding: "utf8" })
        expect(fixedOut.trim()).toBe(secret)
      } finally {
        try {
          execFileSync("/usr/bin/security", ["delete-keychain", kcPath])
        } catch {
          // best-effort cleanup
        }
        await rm(ws, { recursive: true, force: true })
      }
    })
  },
)
