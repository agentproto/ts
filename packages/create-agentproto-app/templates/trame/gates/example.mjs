#!/usr/bin/env node
/**
 * gates/example.mjs — the scaffold's deterministic example gate.
 *
 * Exit 0 = pass; any other exit code = fail. Stdout is ONE line of JSON:
 * {ok, gate, findings[]} — parseable by the AIP-17 gate runner and by
 * `scripts/verify.mjs`. Replace the always-pass check with the app's real
 * mechanical check; keep the shape (one JSON report line, exit code truth).
 */

const findings = []

function report(ok) {
  console.log(JSON.stringify({ ok, gate: "example", findings }))
  process.exit(ok ? 0 : 1)
}

report(true)
