#!/usr/bin/env node
import { runCli } from "./run-cli.js"

runCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    process.stderr.write(`${String(e)}\n`)
    process.exitCode = 1
  },
)
