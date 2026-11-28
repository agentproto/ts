#!/usr/bin/env node
import { defaultIo, main } from "./main"

const controller = new AbortController()
process.once("SIGINT", () => controller.abort())
process.once("SIGTERM", () => controller.abort())

main(process.argv.slice(2), { ...defaultIo(), signal: controller.signal })
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`collect: unhandled error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
