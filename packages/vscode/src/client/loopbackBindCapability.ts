/**
 * Runtime capability probe for the loopback socket bind the DaemonClient
 * suites need: can THIS test process `listen(0, "127.0.0.1")`? In containers
 * or sandboxes where socket bind is denied, every mock-daemon test would
 * hard-fail for environmental, not code, reasons. We attempt the real thing
 * once — a throwaway server on an ephemeral port — observe success vs the
 * error, close it, and cache the verdict per process. No environment
 * sniffing (no CI/hostname/user checks).
 *
 * The probe is synchronous (execFileSync of a child node) because the test
 * file needs the verdict at describe-registration time, and this package
 * compiles as CommonJS where top-level await is rejected by check-types.
 * Binding is observed in a real process either way — same capability, same
 * verdict.
 *
 * `TEST_OVERRIDE` is a test-only hook that forces the probe result so the
 * skip path can be exercised on a capable host; nothing in production code
 * reads it.
 */
import { execFileSync } from "node:child_process"

export type LoopbackBindProbe = { supported: boolean; reason: string }

export const TEST_OVERRIDE: { value: LoopbackBindProbe | null } = { value: null }

let cached: LoopbackBindProbe | null = null

const CHILD_SCRIPT = [
  "const net=require('node:net')",
  "const s=net.createServer()",
  "s.once('error',e=>{console.error(String(e.code||e.message));process.exit(1)})",
  "s.listen(0,'127.0.0.1',()=>{s.close(()=>process.exit(0))})",
].join(";")

export function probeLoopbackBind(): LoopbackBindProbe {
  if (TEST_OVERRIDE.value) return TEST_OVERRIDE.value
  if (cached) return cached
  try {
    execFileSync(process.execPath, ["-e", CHILD_SCRIPT], { stdio: "pipe" })
    cached = { supported: true, reason: "" }
  } catch (err) {
    const out = err as { stdout?: Buffer; stderr?: Buffer }
    const detail = (out.stderr?.toString() ?? "").trim()
    cached = {
      supported: false,
      reason: `cannot bind 127.0.0.1:0${detail ? ` — ${detail}` : ""}`,
    }
  }
  return cached
}