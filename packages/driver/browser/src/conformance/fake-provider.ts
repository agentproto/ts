import { assertCapability } from "../errors.js"
import { defineBrowser } from "../define-browser.js"
import type { BrowserDriver, NetworkRequestSummary } from "../driver.js"
import type { BrowserCapabilitiesInput } from "../capabilities.js"
import type { BrowserInstance, BrowserProvider } from "../provider.js"

/** Deliberate defects, so the kit can be shown to go red on a broken provider. */
export type FakeBrowserFault =
  | "non-idempotent-launch"
  | "health-ok-after-stop"
  | "wrong-evaluate"
  | "empty-dom"
  | "untyped-unsupported"
  | "stop-throws-twice"

export interface FakeBrowserOptions {
  id?: string
  capabilities?: BrowserCapabilitiesInput
  faults?: readonly FakeBrowserFault[]
}

export interface FakeBrowserState {
  launches: number
}

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

function makeDriver(
  kind: string,
  cdp: boolean,
  faults: ReadonlySet<FakeBrowserFault>,
): BrowserDriver {
  let closed = false
  let seq = 0
  const requests: NetworkRequestSummary[] = []
  const gate = (name: "cdp", tool: string): void => {
    if (faults.has("untyped-unsupported")) throw new Error(`${tool} is not available`)
    assertCapability({ cdp }, name, { tool, providerId: kind })
  }
  const driver: BrowserDriver = {
    kind,
    capabilities: {
      canCaptureResponseBodies: cdp,
      canDispatchTrustedInput: false,
      canMultiTarget: false,
      canThrottleNetwork: false,
      isUserVisible: false,
      canScreencast: false,
      canRecordVideo: false,
      canStealth: false,
      canFullPageScreenshot: false,
      canAiActions: false,
    },
    target: { id: "tab-1", url: "about:blank" },
    async navigate(options) {
      driver.target.url = options.url
      seq += 1
      requests.push({
        requestId: `r${seq}`,
        url: options.url,
        method: "GET",
        status: 200,
        startedAt: seq,
        hasResponseBody: true,
      })
    },
    async evaluate<T>() {
      return { value: (faults.has("wrong-evaluate") ? 3 : 2) as T, truncated: false }
    },
    async click() {},
    async fill() {},
    async screenshot() {
      return { base64: ONE_PIXEL_PNG, format: "png", width: 1, height: 1 }
    },
    async getDom() {
      return faults.has("empty-dom") ? "" : "<html><body>fake</body></html>"
    },
    async listRequests() {
      gate("cdp", "browser.list_requests")
      return [...requests]
    },
    async getRequestBody() {
      return { body: "fake body", base64Encoded: false }
    },
    async send<TResult>() {
      gate("cdp", "browser.cdp_send")
      return { product: "FakeBrowser/1.0" } as TResult
    },
    onEvent() {
      return () => {}
    },
    async close() {
      closed = true
    },
    get closed() {
      return closed
    },
  }
  return driver
}

/**
 * In-memory provider that passes every conformance level by default (all
 * capabilities on, one instance per `label`). Pass `faults` for a broken
 * variant, or narrower `capabilities` to see levels skip.
 */
export function createFakeBrowserProvider(
  options: FakeBrowserOptions = {},
): { provider: BrowserProvider; state: FakeBrowserState } {
  const id = options.id ?? "fake-memory"
  const faults = new Set(options.faults ?? [])
  const capabilities: BrowserCapabilitiesInput = options.capabilities ?? {
    cdp: true,
    downloads: true,
    persistentProfile: true,
    headless: true,
    canCaptureResponseBodies: true,
  }
  const cdp = capabilities.cdp === true
  const state: FakeBrowserState = { launches: 0 }
  const running = new Map<string, BrowserInstance & { stopped: boolean; stops: number }>()

  const provider = defineBrowser({
    id,
    name: "In-memory fake browser",
    description: "In-memory provider used to exercise the conformance kit.",
    version: "1.0.0",
    transport: "sdk",
    location: "local",
    capabilities,
    async launch(opts) {
      const key = opts.label ?? "default"
      const existing = running.get(key)
      if (existing && !existing.stopped && !faults.has("non-idempotent-launch")) {
        return { ...existing, wasAlreadyRunning: true }
      }
      state.launches += 1
      const instance: BrowserInstance & { stopped: boolean; stops: number } = {
        id: `${id}:${key}:${faults.has("non-idempotent-launch") ? state.launches : 1}`,
        endpoints: { rest: "http://127.0.0.1:9999", ...(cdp ? { cdp: "ws://127.0.0.1:9222" } : {}) },
        pid: 4242,
        wasAlreadyRunning: false,
        stopped: false,
        stops: 0,
        async health() {
          if (instance.stopped && !faults.has("health-ok-after-stop")) {
            return { ok: false, reason: "stopped" }
          }
          return { ok: true, lifecycle: { bootId: "boot-1", browserState: "running" } }
        },
        async attach() {
          if (instance.stopped) throw new Error("instance is stopped")
          return makeDriver(id, cdp, faults)
        },
        async stop() {
          instance.stops += 1
          if (faults.has("stop-throws-twice") && instance.stops > 1) throw new Error("already stopped")
          instance.stopped = true
        },
      }
      running.set(key, instance)
      return instance
    },
  })
  return { provider, state }
}
