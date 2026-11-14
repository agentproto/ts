/**
 * Unit coverage for `parseServiceList` — the non-throwing wrapper around
 * `serviceList` that runtime's `parseAppServices` now delegates to.
 * `normalizeManifestFields`'s own (throw-based) `services` behavior is
 * covered via `defineApp`/`loadAppHandle` in define-app.test.ts /
 * load-app.test.ts and is unchanged by this wrapper.
 */

import { describe, it, expect } from "vitest"
import {
  DEFAULT_SERVICE_IDLE_STOP_MS,
  DEFAULT_SERVICE_START_TIMEOUT_MS,
  parseServiceList,
} from "../manifest-fields.js"

describe("parseServiceList", () => {
  it("undefined and null are both the no-op case", () => {
    expect(parseServiceList(undefined)).toEqual({ services: [], errors: [] })
    expect(parseServiceList(null)).toEqual({ services: [], errors: [] })
  })

  it("parses name/entry/port entries", () => {
    expect(
      parseServiceList([
        { name: "web", entry: "node server.js", port: 4321 },
        { name: "worker", entry: "node worker.js" },
      ]),
    ).toEqual({
      services: [
        { name: "web", entry: "node server.js", port: 4321 },
        { name: "worker", entry: "node worker.js" },
      ],
      errors: [],
    })
  })

  it("rejects a non-array block", () => {
    const { services, errors } = parseServiceList({ name: "web" })
    expect(services).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it("rejects an explicitly-present but empty array", () => {
    const { services, errors } = parseServiceList([])
    expect(services).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("at least one service")
  })

  it("rejects a name starting with a digit", () => {
    const { errors } = parseServiceList([{ name: "0abc", entry: "x" }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("kebab-case slug")
  })

  it("accepts a name with consecutive/trailing hyphens", () => {
    const { services, errors } = parseServiceList([{ name: "a--b", entry: "x" }])
    expect(errors).toEqual([])
    expect(services).toEqual([{ name: "a--b", entry: "x" }])
  })

  it("rejects an unknown object field", () => {
    const { errors } = parseServiceList([{ name: "web", entry: "x", extra: 1 }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("not a supported service field")
  })

  it("rejects duplicate names", () => {
    const { errors } = parseServiceList([
      { name: "web", entry: "a" },
      { name: "web", entry: "b" },
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("unique")
  })

  it("rejects a bad port (zero, too high, or non-integer)", () => {
    expect(parseServiceList([{ name: "api", entry: "a", port: 0 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
    expect(parseServiceList([{ name: "api", entry: "a", port: 70000 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
    expect(parseServiceList([{ name: "api", entry: "a", port: 1.5 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
  })

  it("fails fast on the first bad entry — a single-element errors array", () => {
    const { errors } = parseServiceList([
      { name: "Bad", entry: "x" },
      { name: "also-bad", entry: "" },
    ])
    expect(errors).toHaveLength(1)
  })

  it("accepts a custom key name in the error message", () => {
    const { errors } = parseServiceList([], "frontmatter.services")
    expect(errors[0]).toContain("'frontmatter.services'")
  })

  describe("cwd (AIP-53: relative to the app dir, no `..` segment)", () => {
    const cwdErrors = (cwd: string) =>
      parseServiceList([{ name: "web", command: "node", cwd }], "services").errors

    it.each(["/etc", "/", "/abs/server"])("rejects the absolute cwd %j", cwd => {
      const errors = cwdErrors(cwd)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("'services[0].cwd'")
      expect(errors[0]).toContain("service 'web'")
      expect(errors[0]).toContain("absolute")
    })

    it.each(["..", "../x", "a/..", "a/../b", "a/b/../../c", "./../x"])(
      "rejects the cwd %j containing a `..` segment",
      cwd => {
        const errors = cwdErrors(cwd)
        expect(errors).toHaveLength(1)
        expect(errors[0]).toContain("'services[0].cwd'")
        expect(errors[0]).toContain("service 'web'")
        expect(errors[0]).toContain("..")
      },
    )

    it.each([".", "./", "sub", "sub/dir", "./sub/dir", "a..b", "..a", "a/..b", "a/b..", "a/.../b"])(
      "accepts the cwd %j",
      cwd => {
        const { services, errors } = parseServiceList([{ name: "web", command: "node", cwd }])
        expect(errors).toEqual([])
        expect(services).toEqual([{ name: "web", command: "node", cwd }])
      },
    )

    it("applies the same rule to the legacy `entry` form", () => {
      expect(parseServiceList([{ name: "web", entry: "x", cwd: "/abs" }]).errors).toHaveLength(1)
      expect(parseServiceList([{ name: "web", entry: "x", cwd: "a/../b" }]).errors).toHaveLength(1)
      expect(parseServiceList([{ name: "web", entry: "x", cwd: "sub/dir" }]).errors).toEqual([])
    })
  })

  describe("expose (AIP-53 Exposure)", () => {
    it("accepts expose with auth and hostname, and expose: {}", () => {
      expect(
        parseServiceList([
          { name: "miniapp", command: "node", port: 8788, expose: { auth: "service", hostname: "session-chat" } },
          { name: "web", entry: "x", port: 80, expose: {} },
          { name: "fq", entry: "x", port: 81, expose: { hostname: "app.example.com", auth: "guard" } },
        ]),
      ).toEqual({
        services: [
          { name: "miniapp", command: "node", port: 8788, expose: { auth: "service", hostname: "session-chat" } },
          { name: "web", entry: "x", port: 80, expose: {} },
          { name: "fq", entry: "x", port: 81, expose: { auth: "guard", hostname: "app.example.com" } },
        ],
        errors: [],
      })
    })

    it("rejects expose without a port", () => {
      const { errors } = parseServiceList([{ name: "a", entry: "x" }, { name: "b", entry: "x", expose: {} }])
      expect(errors).toEqual(["services[1].expose requires a port"])
    })

    it("rejects an unknown expose key, a bad auth and a bad hostname", () => {
      expect(parseServiceList([{ name: "a", entry: "x", port: 1, expose: { provider: "ngrok" } }]).errors[0]).toContain(
        "'services[0].expose.provider'",
      )
      expect(parseServiceList([{ name: "a", entry: "x", port: 1, expose: { auth: "none" } }]).errors[0]).toContain(
        "'services[0].expose.auth'",
      )
      for (const hostname of ["Session-Chat", "-bad", "a..b", "", "a_b", 42]) {
        expect(parseServiceList([{ name: "a", entry: "x", port: 1, expose: { hostname } }]).errors[0]).toContain(
          "'services[0].expose.hostname'",
        )
      }
      expect(parseServiceList([{ name: "a", entry: "x", port: 1, expose: "yes" }]).errors[0]).toContain(
        "'services[0].expose'",
      )
    })
  })
  describe("activation (AIP-53 Activation)", () => {
    it("accepts always and on-demand, carried verbatim without defaults filled in", () => {
      const services = [
        { name: "a", entry: "x", port: 1 },
        { name: "b", entry: "x", port: 2, activation: { mode: "always" } },
        { name: "c", command: "node", port: 3, activation: { mode: "on-demand" } },
        {
          name: "d",
          command: "node",
          port: 4,
          expose: { auth: "service" },
          activation: { mode: "on-demand", idleStopMs: 60_000, startTimeoutMs: 5_000 },
        },
      ]
      expect(parseServiceList(services)).toEqual({ services, errors: [] })
    })

    it("exports the defaults the host applies when a field is omitted", () => {
      expect(DEFAULT_SERVICE_IDLE_STOP_MS).toBe(300_000)
      expect(DEFAULT_SERVICE_START_TIMEOUT_MS).toBe(30_000)
    })

    it("rejects on-demand without a port, but not always", () => {
      expect(
        parseServiceList([{ name: "a", entry: "x", activation: { mode: "on-demand" } }]).errors,
      ).toEqual(["services[0].activation.mode 'on-demand' requires a port"])
      expect(parseServiceList([{ name: "a", entry: "x", activation: { mode: "always" } }]).errors).toEqual([])
    })

    it("requires a known mode and rejects unknown keys", () => {
      for (const activation of [{}, { mode: "lazy" }, { mode: 1 }]) {
        expect(parseServiceList([{ name: "a", entry: "x", port: 1, activation }]).errors[0]).toContain(
          "'services[0].activation.mode'",
        )
      }
      expect(
        parseServiceList([{ name: "a", entry: "x", port: 1, activation: { mode: "on-demand", scale: 2 } }]).errors[0],
      ).toContain("'services[0].activation.scale'")
      expect(parseServiceList([{ name: "a", entry: "x", port: 1, activation: "on-demand" }]).errors[0]).toContain(
        "'services[0].activation'",
      )
    })

    it("bounds idleStopMs (1000..86400000) and startTimeoutMs (1000..300000) to integers", () => {
      for (const idleStopMs of [0, 999, 86_400_001, 1.5, "60000", null]) {
        expect(
          parseServiceList([{ name: "a", entry: "x", port: 1, activation: { mode: "on-demand", idleStopMs } }])
            .errors[0],
        ).toContain("'services[0].activation.idleStopMs'")
      }
      for (const startTimeoutMs of [0, 999, 300_001, 2.5, "5000"]) {
        expect(
          parseServiceList([{ name: "a", entry: "x", port: 1, activation: { mode: "on-demand", startTimeoutMs } }])
            .errors[0],
        ).toContain("'services[0].activation.startTimeoutMs'")
      }
      expect(
        parseServiceList([
          { name: "a", entry: "x", port: 1, activation: { mode: "on-demand", idleStopMs: 1_000, startTimeoutMs: 300_000 } },
          { name: "b", entry: "x", port: 2, activation: { mode: "on-demand", idleStopMs: 86_400_000 } },
        ]).errors,
      ).toEqual([])
    })

    it("rejects the on-demand-only knobs under mode always", () => {
      for (const knob of ["idleStopMs", "startTimeoutMs"]) {
        expect(
          parseServiceList([{ name: "a", entry: "x", port: 1, activation: { mode: "always", [knob]: 5_000 } }]).errors,
        ).toEqual([`'services[0].activation.${knob}' is only valid with mode 'on-demand'.`])
      }
    })
  })
})
