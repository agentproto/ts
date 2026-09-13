import { afterEach, beforeEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Package-wide hermetic gate: every `~/.agentproto/*` store in this package
// (harness-preset-store, llm-endpoint-links-store, workspace-buckets,
// routes-config, tunnel-registry, …) resolves its path under `os.homedir()`,
// which reads `$HOME` on POSIX. Left pointed at the real developer machine,
// a spawn test can silently pick up whatever the developer has ACTUALLY
// persisted there (e.g. a real default harness preset) and fail in a way
// that looks like a product bug but is really the test reading live local
// state — the exact failure mode this global override closes off. Individual
// suites that need a specific fixture layout still set up their own temp
// `$HOME` (this just supplies the default so no suite has to opt in).
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-runtime-test-home-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  // maxRetries/retryDelay: a just-finished test can leave an async write
  // (session persistence, a background adapter) still landing a file under
  // `home` — a bare recursive rm can lose that race with ENOTEMPTY. Node's
  // built-in retry absorbs it without a bespoke loop.
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
