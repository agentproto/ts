import { assertToolSupported, isBrowserUnsupportedError } from "../errors.js"
import { browserHealthSchema, browserInstanceInfoSchema, browserManifestSchema } from "../provider.js"
import {
  networkRequestSummarySchema,
  screenshotResultSchema,
} from "../driver.js"
import type { BrowserCapabilityName } from "../capabilities.js"
import {
  ConformanceSkip,
  type ConformanceCheck,
  type ConformanceLevel,
} from "./types.js"

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}

/** Capability a whole level needs; absent means the level is skipped with `browser:unsupported`. */
export const LEVEL_REQUIRES: Partial<Record<ConformanceLevel, BrowserCapabilityName>> = {
  network: "cdp",
  download: "downloads",
  profile: "persistentProfile",
}

const core: ConformanceCheck[] = [
  {
    level: "core",
    name: "manifest",
    async run({ provider }) {
      const { launch: _launch, check: _check, ...manifest } = provider
      const parsed = browserManifestSchema.safeParse(manifest)
      expect(parsed.success, "manifest does not satisfy browserManifestSchema")
    },
  },
  {
    level: "core",
    name: "instance-shape",
    async run({ instance }) {
      const info = browserInstanceInfoSchema.safeParse({
        id: instance.id,
        endpoints: instance.endpoints,
        pid: instance.pid,
        wasAlreadyRunning: instance.wasAlreadyRunning,
      })
      expect(info.success, "instance does not satisfy browserInstanceInfoSchema")
      expect(
        instance.endpoints.rest !== undefined || instance.endpoints.cdp !== undefined,
        "instance exposes neither a rest nor a cdp endpoint",
      )
    },
  },
  {
    level: "core",
    name: "launch-idempotent",
    async run({ instance, launch }) {
      const again = await launch("conformance-core")
      expect(again.wasAlreadyRunning === true, "second launch with the same label must report wasAlreadyRunning: true")
      expect(again.id === instance.id, "second launch with the same label must return the same instance id")
    },
  },
  {
    level: "core",
    name: "health",
    async run({ instance }) {
      const health = await instance.health()
      expect(browserHealthSchema.safeParse(health).success, "health() does not satisfy browserHealthSchema")
      expect(health.ok === true, `health() must be ok on a running instance (reason: ${health.reason ?? "none"})`)
    },
  },
  {
    level: "core",
    name: "navigate",
    async run({ driver, fixture }) {
      await driver.navigate({ url: fixture.url ?? "about:blank", waitUntil: "load" })
    },
  },
  {
    level: "core",
    name: "stop-idempotent",
    async run({ launch }) {
      const victim = await launch("conformance-stop")
      await victim.stop()
      await victim.stop()
      const health = await victim.health()
      expect(health.ok === false, "health() must not be ok after stop()")
    },
  },
  {
    level: "core",
    name: "remote-no-local-pid",
    async run({ provider, instance }) {
      if (provider.location !== "remote") throw new ConformanceSkip("provider is local")
      expect(instance.pid === undefined, "a remote instance must not report a local pid")
    },
  },
  {
    level: "core",
    name: "driver-close",
    async run({ instance }) {
      const scratch = await instance.attach()
      await scratch.close()
      expect(scratch.closed === true, "driver.closed must be true after close()")
    },
  },
]

const interaction: ConformanceCheck[] = [
  {
    level: "interaction",
    name: "evaluate",
    async run({ driver }) {
      const result = await driver.evaluate<number>({
        expression: "1 + 1",
        awaitPromise: true,
        returnByValue: true,
        maxResultBytes: 64_000,
      })
      expect(result.value === 2, `evaluate("1 + 1") returned ${JSON.stringify(result.value)}, expected 2`)
    },
  },
  {
    level: "interaction",
    name: "get-dom",
    async run({ driver }) {
      const dom = await driver.getDom()
      expect(typeof dom === "string" && dom.length > 0, "getDom() must return a non-empty string")
    },
  },
  {
    level: "interaction",
    name: "screenshot",
    async run({ driver }) {
      const shot = await driver.screenshot({ format: "png", fullPage: false })
      expect(screenshotResultSchema.safeParse(shot).success, "screenshot() does not satisfy screenshotResultSchema")
      expect(shot.base64.length > 0, "screenshot() returned no image data")
    },
  },
  {
    level: "interaction",
    name: "click-fill",
    async run({ driver, fixture }) {
      if (!fixture.inputSelector || !fixture.buttonSelector) {
        throw new ConformanceSkip("no fixture inputSelector/buttonSelector")
      }
      await driver.fill({ selector: fixture.inputSelector, value: "conformance", clear: true })
      await driver.click({ selector: fixture.buttonSelector, button: "left", clickCount: 1, trusted: true })
    },
  },
]

const network: ConformanceCheck[] = [
  {
    level: "network",
    name: "list-requests",
    async run({ driver, fixture }) {
      await driver.navigate({ url: fixture.url ?? "about:blank", waitUntil: "load" })
      const requests = await driver.listRequests({ limit: 50 })
      expect(Array.isArray(requests), "listRequests() must return an array")
      for (const r of requests) {
        expect(networkRequestSummarySchema.safeParse(r).success, "a request does not satisfy networkRequestSummarySchema")
      }
    },
  },
  {
    level: "network",
    name: "cdp-send",
    async run({ driver }) {
      const version = await driver.send<Record<string, unknown>>({ method: "Browser.getVersion" })
      expect(typeof version === "object" && version !== null, "send(Browser.getVersion) must resolve to an object")
    },
  },
  {
    level: "network",
    name: "request-body",
    async run({ driver }) {
      if (!driver.capabilities.canCaptureResponseBodies) {
        throw new ConformanceSkip("driver does not capture response bodies")
      }
      const withBody = (await driver.listRequests({ limit: 50 })).find((r) => r.hasResponseBody === true)
      if (!withBody) throw new ConformanceSkip("no captured request has a body")
      const body = await driver.getRequestBody(withBody.requestId)
      expect(typeof body.body === "string", "getRequestBody() must return a string body")
    },
  },
]

const download: ConformanceCheck[] = [
  {
    level: "download",
    name: "gate-consistent",
    async run({ provider }) {
      assertToolSupported(provider.capabilities, "browser.download", provider.id)
    },
  },
]

const profile: ConformanceCheck[] = [
  {
    level: "profile",
    name: "relaunch-with-profile",
    async run({ launch }) {
      const first = await launch("conformance-profile", { profile: "conformance-profile" })
      await first.stop()
      const second = await launch("conformance-profile", { profile: "conformance-profile" })
      const health = await second.health()
      expect(health.ok === true, "an instance relaunched with the same profile must be healthy")
    },
  },
]

export const BUILTIN_CHECKS: Readonly<Record<ConformanceLevel, readonly ConformanceCheck[]>> = {
  core,
  interaction,
  network,
  download,
  profile,
}

/** Probe run when `network` is skipped: the missing capability must fail with the typed error, not an opaque one. */
export const TYPED_UNSUPPORTED_PROBE: ConformanceCheck = {
  level: "network",
  name: "typed-unsupported",
  async run({ driver }) {
    try {
      await driver.listRequests({ limit: 1 })
    } catch (err) {
      expect(
        isBrowserUnsupportedError(err) && err.capability === "cdp",
        `listRequests() without the cdp capability must throw browser:unsupported naming "cdp", got: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }
    throw new Error("listRequests() must throw browser:unsupported when the provider lacks the cdp capability")
  },
}
