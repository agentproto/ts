import {
  assertCapability,
  defineBrowser,
  type BrowserDriver,
  type BrowserInstance,
  type BrowserManifestInput,
  type BrowserProvider,
} from "../index.js"

export interface FakeProviderState {
  launches: number
  running: Map<string, FakeInstance>
}

export interface FakeInstance extends BrowserInstance {
  stopped: boolean
  drivers: BrowserDriver[]
}

function makeDriver(kind: string, cdp: boolean): BrowserDriver {
  let closed = false
  const provider = { providerId: kind }
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
    },
    async evaluate<T>() {
      return { value: undefined as T | undefined, truncated: false }
    },
    async click() {},
    async fill() {},
    async screenshot() {
      return { base64: "", format: "png", width: 1, height: 1 }
    },
    async getDom() {
      return "<html></html>"
    },
    async listRequests() {
      assertCapability({ cdp }, "cdp", { tool: "browser.list_requests", ...provider })
      return []
    },
    async getRequestBody() {
      return { body: "", base64Encoded: false }
    },
    async send() {
      assertCapability({ cdp }, "cdp", { tool: "browser.cdp_send", ...provider })
      return undefined as never
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

/** In-memory provider: one instance per `label`, reused on a second launch. */
export function makeFakeProvider(
  manifest: Partial<BrowserManifestInput> = {},
): { provider: BrowserProvider; state: FakeProviderState } {
  const state: FakeProviderState = { launches: 0, running: new Map() }
  const id = manifest.id ?? "fake"
  const cdp = manifest.capabilities?.cdp === true

  const provider = defineBrowser({
    id,
    name: "Fake browser",
    description: "In-memory provider for tests.",
    version: "1.0.0",
    transport: "sdk",
    location: "local",
    ...manifest,
    async launch(opts) {
      const key = opts.label ?? "default"
      const existing = state.running.get(key)
      if (existing && !existing.stopped) {
        return { ...existing, wasAlreadyRunning: true }
      }
      state.launches += 1
      const instance: FakeInstance = {
        id: `${id}:${key}:${state.launches}`,
        endpoints: { rest: "http://127.0.0.1:9999", ...(cdp ? { cdp: "ws://127.0.0.1:9222" } : {}) },
        pid: 4242,
        wasAlreadyRunning: false,
        stopped: false,
        drivers: [],
        async health() {
          return instance.stopped
            ? { ok: false, reason: "stopped" }
            : {
                ok: true,
                lifecycle: { bootId: "boot-1", browserState: "running", lastRestartReason: null },
              }
        },
        async attach() {
          if (instance.stopped) throw new Error("instance is stopped")
          const driver = makeDriver(id, cdp)
          instance.drivers.push(driver)
          return driver
        },
        async stop() {
          instance.stopped = true
        },
      }
      state.running.set(key, instance)
      return instance
    },
  })
  return { provider, state }
}
