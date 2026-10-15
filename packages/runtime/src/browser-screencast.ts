/**
 * chrome-live screencast recording — mp4 assembly for the frames a
 * `browser_screencast_stop` hands back.
 *
 * The frames arrive as base64 JPEG (or PNG) stills straight from CDP
 * `Page.screencastFrame`. mp4 encoding needs a real video toolchain: ffmpeg
 * (checked for on PATH at encode time; the tool answers with a clear "install
 * ffmpeg" error when absent rather than failing obscurely).
 *
 * Stateless-MCP note: nothing live lives here — the long-lived frame buffer is
 * owned by the chrome-live adapter instance (module-level `entries` in
 * adapters/browser-chrome/src/live.ts, reached through the module-scope
 * `liveInstances` map in browser-tools.ts). This module is a pure
 * frames-in → file-out function, so per-request tool factory re-runs can never
 * strand recording state (the liveInstances bug class).
 */

import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Frame shape shared with the adapter's ChromeLiveScreencastFrame (structural — no adapter import). */
export interface ScreencastFrameLike {
  data: string
  format: "jpeg" | "png"
  timestampMs: number
  index: number
  width?: number
  height?: number
}

const FRAME_FALLBACK_INTERVAL_S = 0.25

async function probe(command: string): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const child = spawn(command, ["-version"], { stdio: "ignore" })
    child.on("error", () => resolve(false))
    child.on("close", code => resolve(code === 0))
  })
}

/**
 * Encode buffered screencast frames into an mp4 at `outPath`.
 *
 * Uses the concat demuxer with a per-frame `duration` (frames arrive on an
 * irregular cadence), re-timed to 10fps so players handle the sparse stream.
 * Resolves the output path; throws with a clear cause when ffmpeg is missing
 * or fails.
 */
export async function encodeScreencastFramesToMp4(
  frames: ScreencastFrameLike[],
  outPath: string,
  opts: { fps?: number } = {},
): Promise<string> {
  if (frames.length < 2) throw new Error("need at least 2 frames to encode a recording")
  const work = await mkdtemp(join(tmpdir(), "chrome-live-screencast-"))
  try {
    const ext = frames[0]!.format === "png" ? "png" : "jpg"
    const list: string[] = []
    // Per-frame delta (clamped): the concat demuxer expects each entry's
    // duration to be SHOW TIME of that file, not a cumulative offset —
    // cumulative values made recent-motion recordings play ~40× too slow.
    const clamp = (v: number) => Math.min(Math.max(v, 0.05), 2)
    for (const [i, frame] of frames.entries()) {
      const file = `f${String(i).padStart(4, "0")}.${ext}`
      await writeFile(join(work, file), Buffer.from(frame.data, "base64"))
      const prev = i === 0 ? frames[0]!.timestampMs : frames[i - 1]!.timestampMs
      list.push(`file '${file}'`, `duration ${clamp((frame.timestampMs - prev) / 1000)}`)
    }
    // The concat demuxer needs the last file named again (its duration is ignored).
    list.push(`file 'f${String(frames.length - 1).padStart(4, "0")}.${ext}'`)
    const listPath = join(work, "list.txt")
    await writeFile(listPath, list.join("\n") + "\n")

    const fps = opts.fps ?? 10
    let stderr = ""
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-vf",
        `scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${fps}`,
        "-pix_fmt",
        "yuv420p",
        outPath,
      ])
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(err.code === "ENOENT" ? new Error("ffmpeg is not installed — install it (e.g. `brew install ffmpeg`) to encode screencast recordings") : err)
      })
      child.on("close", code => resolve(code ?? -1))
    })
    if (code !== 0) throw new Error(`ffmpeg failed (exit ${code})${stderr ? `: ${stderr.trim().slice(-400)}` : ""}`)
    return outPath
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Ensure the output directory exists (the session dir normally does, but be safe). */
export async function prepareScreencastOutDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** `ffmpeg` presence — exported so tools/tests can degrade gracefully without guessing. */
export async function hasFfmpeg(): Promise<boolean> {
  return await probe("ffmpeg")
}
