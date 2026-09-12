/**
 * Runtime capability probe for macOS Seatbelt: can THIS test process actually
 * spawn `sandbox-exec`? Inside an already-confined environment (e.g. a seatbelt
 * sandbox itself) `sandbox_apply` is denied with EPERM, so the end-to-end tests
 * would hard-fail for environmental, not code, reasons. We attempt the real
 * thing once — a trivial profile running /usr/bin/true — and cache the
 * verdict per process. No environment sniffing (no CI/hostname/user checks).
 *
 * `TEST_OVERRIDE` is a test-only hook that forces the probe result so the
 * skip path can be exercised on a capable host; nothing in production code
 * reads it.
 */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"

export type SeatbeltProbe = { supported: boolean; reason: string }

export const TEST_OVERRIDE: { value: SeatbeltProbe | null } = { value: null }

let cached: SeatbeltProbe | null = null

export function probeSeatbelt(): SeatbeltProbe {
  if (TEST_OVERRIDE.value) return TEST_OVERRIDE.value
  if (cached) return cached
  if (process.platform !== "darwin") {
    cached = { supported: false, reason: "not macOS — sandbox-exec does not exist" }
  } else if (!existsSync("/usr/bin/sandbox-exec")) {
    cached = { supported: false, reason: "/usr/bin/sandbox-exec not found" }
  } else {
    try {
      execFileSync(
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", "/usr/bin/true"],
        { stdio: "pipe" },
      )
      cached = { supported: true, reason: "" }
    } catch {
      cached = {
        supported: false,
        reason:
          "nested sandbox-exec denied (sandbox_apply: Operation not permitted) — this test process is already confined",
      }
    }
  }
  return cached
}