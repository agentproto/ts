/**
 * Runtime capability probe for the hermes smoke test: does HERMES_BIN point
 * at a binary that EXISTS and EXECUTES on this machine? A stale path (binary
 * moved/uninstalled) turns the smoke test into a spawn failure on every local
 * run. We attempt the real thing once — a `--version` spawn with a short
 * timeout — and cache the verdict per process. No environment sniffing.
 *
 * This is a binary-path probe, not a credential probe: no HTTP, no key. If
 * the binary exists and executes at all, the capability holds — even a
 * non-zero exit from `--version` means the file ran, so the verdict is
 * supported and the suite proceeds to fail honestly if the turn itself
 * breaks. Only a definitive "cannot run this file" (ENOENT / EACCES) skips.
 *
 * `TEST_OVERRIDE` is a test-only hook that forces the probe result so the
 * skip path can be exercised on a capable host; nothing in production code
 * reads it.
 */
import { execFileSync } from "node:child_process"

export type HermesBinProbe = { supported: boolean; reason: string }

export const TEST_OVERRIDE: { value: HermesBinProbe | null } = { value: null }

let cached: HermesBinProbe | null = null

export function probeHermesBin(): HermesBinProbe {
  if (TEST_OVERRIDE.value) return TEST_OVERRIDE.value
  if (cached) return cached
  const bin = process.env.HERMES_BIN
  if (!bin) {
    cached = { supported: false, reason: "HERMES_BIN not set" }
    return cached
  }
  try {
    execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 5_000 })
    cached = { supported: true, reason: "" }
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === "ENOENT" || code === "EACCES") {
      cached = {
        supported: false,
        reason: `HERMES_BIN (${bin}) cannot be executed — ${code}`,
      }
    } else {
      // The binary exists and ran (`--version` merely exited non-zero or the
      // probe hit its timeout). That is the capability we need — run the
      // suite and let the turn itself fail honestly if something is broken.
      cached = { supported: true, reason: "" }
    }
  }
  return cached
}
