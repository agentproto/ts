import { hasCapability } from "../capabilities.js"
import type { BrowserDriver } from "../driver.js"
import { isBrowserUnsupportedError } from "../errors.js"
import type { BrowserInstance, BrowserLaunchOptions, BrowserProvider } from "../provider.js"
import { BUILTIN_CHECKS, LEVEL_REQUIRES, TYPED_UNSUPPORTED_PROBE } from "./checks.js"
import {
  CONFORMANCE_LEVELS,
  ConformanceSkip,
  type ConformanceCheck,
  type ConformanceCheckResult,
  type ConformanceContext,
  type ConformanceLevel,
  type ConformanceLevelReport,
  type ConformanceOptions,
  type ConformanceReport,
} from "./types.js"

const DEFAULT_CHECK_TIMEOUT_MS = 15_000

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function runCheck(
  check: ConformanceCheck,
  ctx: ConformanceContext,
  timeoutMs: number,
): Promise<ConformanceCheckResult> {
  const started = Date.now()
  const base = { level: check.level, name: check.name }
  try {
    await withTimeout(check.run(ctx), timeoutMs, `check ${check.level}/${check.name}`)
    return { ...base, status: "pass", durationMs: Date.now() - started }
  } catch (err) {
    const durationMs = Date.now() - started
    if (err instanceof ConformanceSkip) {
      return { ...base, status: "skip", durationMs, message: err.message }
    }
    if (isBrowserUnsupportedError(err)) {
      return {
        ...base,
        status: "skip",
        durationMs,
        message: err.message,
        unsupportedCapability: err.capability,
      }
    }
    return { ...base, status: "fail", durationMs, message: message(err) }
  }
}

async function runLevel(
  provider: BrowserProvider,
  level: ConformanceLevel,
  options: ConformanceOptions,
): Promise<ConformanceLevelReport> {
  const timeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const required = LEVEL_REQUIRES[level]
  const unsupported = required !== undefined && !hasCapability(provider.capabilities, required)
  const extras = (options.extraChecks ?? []).filter((c) => c.level === level)
  const checks: readonly ConformanceCheck[] = unsupported
    ? level === "network"
      ? [TYPED_UNSUPPORTED_PROBE]
      : []
    : [...BUILTIN_CHECKS[level], ...extras]

  const launched: BrowserInstance[] = []
  const launch = async (label: string, extra: BrowserLaunchOptions = {}): Promise<BrowserInstance> => {
    const instance = await withTimeout(
      provider.launch({ ...options.launch, ...extra, label }, options.hostContext ?? {}),
      timeoutMs,
      `launch ${label}`,
    )
    launched.push(instance)
    return instance
  }

  const results: ConformanceCheckResult[] = []
  try {
    if (checks.length > 0) {
      let instance: BrowserInstance | undefined
      let driver: BrowserDriver | undefined
      const setupStarted = Date.now()
      try {
        instance = await launch(`conformance-${level}`)
        driver = await withTimeout(instance.attach(), timeoutMs, "attach")
      } catch (err) {
        const step = instance ? "attach" : "launch"
        results.push({
          level,
          name: step,
          status: "fail",
          durationMs: Date.now() - setupStarted,
          message: message(err),
        })
        for (const c of checks) {
          results.push({ level, name: c.name, status: "skip", durationMs: 0, message: `${step} failed` })
        }
      }
      if (instance && driver) {
        const ctx: ConformanceContext = {
          provider,
          instance,
          driver,
          fixture: options.fixture ?? {},
          launch,
        }
        for (const c of checks) results.push(await runCheck(c, ctx, timeoutMs))
        await driver.close().catch(() => {})
      }
    }
  } finally {
    for (const instance of launched) await instance.stop().catch(() => {})
  }

  const failed = results.some((r) => r.status === "fail")
  if (unsupported && !failed) {
    return {
      level,
      status: "skipped",
      checks: results,
      skipReason: `provider lacks the "${required}" capability (browser:unsupported)`,
      unsupportedCapability: required,
    }
  }
  return { level, status: failed ? "fail" : "pass", checks: results }
}

/**
 * Run the conformance kit against a provider. Levels whose capability the
 * provider does not declare are skipped (typed `browser:unsupported`), never
 * failed. A check throwing `BrowserUnsupportedError` is likewise a skip.
 */
export async function runConformance(
  provider: BrowserProvider,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const wanted = options.levels ?? CONFORMANCE_LEVELS
  const levels: ConformanceLevelReport[] = []
  for (const level of CONFORMANCE_LEVELS) {
    if (wanted.includes(level)) levels.push(await runLevel(provider, level, options))
  }
  const failed = levels.flatMap((l) =>
    l.checks.filter((c) => c.status === "fail").map((c) => `${l.level}/${c.name}`),
  )
  return {
    providerId: provider.id,
    location: provider.location,
    ok: levels.every((l) => l.status !== "fail"),
    levels,
    failed,
  }
}
