import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  defaultCloudCliRunner,
  normalizePtyOutput,
  parseCloudStartOutput,
  startCloudSession,
  type PtyProcess,
  type PtySpawn,
} from "../cli.js"

// The exact bytes a live claude 2.1.299 PTY drew for the first-run folder
// trust prompt: word-by-word, each run positioned with a cursor-column escape
// instead of a space, so `Yes, I trust this folder` never appears literally.
const TRUST_PROMPT =
  "\x1b[2G\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m ... " +
  "\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis ... " +
  "\x1b[2G\x1b[94m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n" +
  "\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder"

const DOWN_ENTER = "\x1b[B\r"

const CREATED_ESCAPED =
  "\x1b[1mCreated\x1b[10Gcloud\x1b[16Gsession:\x1b[25Gfix\x1b[29Gthe\x1b[33Gflaky\x1b[39Gtest\x1b[0m"
const RESUME_ESCAPED =
  "\x1b[1mResume\x1b[8Gwith:\x1b[14Gclaude\x1b[21G--teleport\x1b[32Gsession_01XyzAbC\x1b[0m"

interface FakeApi {
  emit(chunk: string): void
  exit(code: number): void
}

interface FakeScript {
  /** Runs once the runner has attached its handlers. */
  onAttach?: (api: FakeApi) => void
  /** Runs on every write the runner sends to the PTY. */
  onWrite?: (data: string, api: FakeApi) => void
}

/** A stand-in for node-pty: drives a canned script without a native PTY. */
function fakePty(script: FakeScript): { spawn: PtySpawn; writes: string[] } {
  const writes: string[] = []
  const spawn: PtySpawn = (): PtyProcess => {
    const dataCbs: Array<(chunk: string) => void> = []
    const exitCbs: Array<(event: { exitCode: number }) => void> = []
    const api: FakeApi = {
      emit: chunk => {
        for (const cb of [...dataCbs]) cb(chunk)
      },
      exit: code => {
        for (const cb of [...exitCbs]) cb({ exitCode: code })
      },
    }
    const pty: PtyProcess = {
      onData(cb) {
        dataCbs.push(cb)
      },
      onExit(cb) {
        exitCbs.push(cb)
      },
      write(data) {
        writes.push(data)
        script.onWrite?.(data, api)
      },
      kill() {},
    }
    queueMicrotask(() => script.onAttach?.(api))
    return pty
  }
  return { spawn, writes }
}

describe("normalizePtyOutput", () => {
  it("turns cursor escapes into spaces and strips SGR/OSC", () => {
    expect(normalizePtyOutput(TRUST_PROMPT)).toContain("Yes, I trust this folder")
    expect(normalizePtyOutput("\x1b]0;title\x07hi\x1b[0m there")).toBe("hi there")
    expect(normalizePtyOutput("\x1b]0;title\x1b\\hi")).toBe("hi")
    expect(normalizePtyOutput("a\x1bb c")).not.toContain("\x1b")
  })

  it("preserves line boundaries so line regexes still match", () => {
    expect(normalizePtyOutput("one\ntwo\n\nthree")).toBe("one\ntwo\nthree")
  })
})

describe("startCloudSession trust prompt", () => {
  it("detects the escape-separated trust prompt and sends Down+Enter exactly once", async () => {
    const { spawn, writes } = fakePty({
      onAttach: api => {
        // The TUI may redraw the prompt; the answer must still be sent once.
        api.emit(TRUST_PROMPT)
        api.emit(TRUST_PROMPT)
      },
      onWrite: (data, api) => {
        if (data === DOWN_ENTER) {
          api.emit(CREATED_ESCAPED)
          api.emit("\n")
          api.emit(RESUME_ESCAPED)
          api.exit(0)
        }
      },
    })
    const runner = defaultCloudCliRunner({ spawnPty: spawn })
    const started = await startCloudSession("fix the flaky test", {
      runner,
      cwd: "/repo",
      skipPreflight: true,
    })

    expect(writes.filter(w => w === DOWN_ENTER)).toHaveLength(1)
    expect(started).toEqual({
      sessionId: "session_01XyzAbC",
      url: "https://claude.ai/code/session_01XyzAbC",
      title: "fix the flaky test",
    })
  })

  it("pre-trusts the cwd so a PTY that would show the trust dialog can start", async () => {
    const home = mkdtempSync(join(tmpdir(), "claude-cloud-trust-"))
    const cwd = mkdtempSync(join(tmpdir(), "claude-cloud-cwd-"))
    const configFile = join(home, ".claude.json")
    try {
      const { spawn } = fakePty({
        onAttach: api => {
          const config = JSON.parse(readFileSync(configFile, "utf8")) as {
            projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
          }
          if (!config.projects?.[cwd]?.hasTrustDialogAccepted) {
            // What a live clean runner does: render the dialog and ignore
            // input until the human answers. On main this stalls to timeout.
            api.emit(TRUST_PROMPT)
            return
          }
          api.emit(CREATED_ESCAPED)
          api.emit("\n")
          api.emit(RESUME_ESCAPED)
          api.exit(0)
        },
      })
      const runner = defaultCloudCliRunner({ spawnPty: spawn })
      const started = await startCloudSession("fix the flaky test", {
        runner,
        cwd,
        env: { HOME: home, PATH: process.env.PATH },
        skipPreflight: true,
        timeoutMs: 250,
      })

      expect(started.sessionId).toBe("session_01XyzAbC")
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("parses escaped Created cloud session / --teleport lines", () => {
    expect(
      parseCloudStartOutput(`${CREATED_ESCAPED}\n${RESUME_ESCAPED}`),
    ).toEqual({
      sessionId: "session_01XyzAbC",
      url: "https://claude.ai/code/session_01XyzAbC",
      title: "fix the flaky test",
    })
  })
})

describe("startCloudSession timeout", () => {
  it("reports a bounded, ANSI-stripped tail of the stalled screen", async () => {
    const screen =
      "\x1b[2Gclaude\x1b[9Gis\x1b[12Gstalling " +
      "A".repeat(500) +
      "\x1b[0mEND_OF_SCREEN"
    const { spawn } = fakePty({ onAttach: api => api.emit(screen) })
    const runner = defaultCloudCliRunner({ spawnPty: spawn })

    let err: Error | undefined
    try {
      await startCloudSession("do a thing", {
        runner,
        cwd: "/repo",
        skipPreflight: true,
        timeoutMs: 30,
      })
    } catch (e) {
      err = e as Error
    }

    expect(err).toBeInstanceOf(Error)
    const message = err?.message ?? ""
    expect(message).toMatch(/timed out after 30ms under the PTY/)
    expect(message).toContain("END_OF_SCREEN")
    expect(message).not.toContain("\x1b")
    const tail = message.split("last output: ")[1] ?? ""
    expect(tail.length).toBeLessThanOrEqual(300)
  })
})
