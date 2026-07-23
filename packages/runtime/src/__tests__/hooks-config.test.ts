/**
 * Unit tests for the semantic hook engine's config loader (`hooks-config.ts`):
 * rule loading from `.agentproto/hooks.json`, the required `plane:` tag, the
 * RISK-0 GUARD (a `security`-intent rule can't compile to a Plane-1-only
 * hold/deny), and `decide()`'s LOG-ONLY-DEFAULT contract — an empty or
 * log-only rule set must reproduce today's `permissionHold`-boolean
 * behavior exactly (see PR 4 of the command-logger-hooks readiness audit).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  decide,
  decideRule,
  HooksConfigError,
  loadHooksConfig,
  parseHooksConfig,
  type HookRule,
} from "../hooks-config.js"

function writeHooksConfig(workspace: string, body: unknown): void {
  mkdirSync(join(workspace, ".agentproto"), { recursive: true })
  writeFileSync(join(workspace, ".agentproto", "hooks.json"), JSON.stringify(body))
}

describe("hooks-config", () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "hooks-config-test-"))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  describe("loadHooksConfig — rule loading", () => {
    it("returns no rules when hooks.json is absent", () => {
      expect(loadHooksConfig(workspace)).toEqual([])
    })

    it("loads a well-formed rule table", () => {
      writeHooksConfig(workspace, {
        version: 1,
        rules: [
          { id: "log-bash", plane: "semantic", match: { tool: "Bash" }, action: "log" },
        ],
      })
      const rules = loadHooksConfig(workspace)
      expect(rules).toEqual([
        { id: "log-bash", plane: "semantic", match: { tool: "Bash" }, action: "log" },
      ])
    })

    it("degrades to no rules (logged, not thrown) on malformed JSON", () => {
      mkdirSync(join(workspace, ".agentproto"), { recursive: true })
      writeFileSync(join(workspace, ".agentproto", "hooks.json"), "{not json")
      expect(loadHooksConfig(workspace)).toEqual([])
    })

    it("degrades to no rules when a rule fails validation, rather than throwing at the seam", () => {
      writeHooksConfig(workspace, { rules: [{ id: "bad", match: {}, action: "log" }] })
      expect(loadHooksConfig(workspace)).toEqual([])
    })
  })

  describe("parseHooksConfig — plane-tag validation", () => {
    it("throws when a rule omits plane", () => {
      expect(() =>
        parseHooksConfig(JSON.stringify({ rules: [{ id: "r1", match: {}, action: "log" }] })),
      ).toThrow(HooksConfigError)
    })

    it("throws when plane is neither semantic nor blast-radius", () => {
      expect(() =>
        parseHooksConfig(
          JSON.stringify({ rules: [{ id: "r1", plane: "nope", match: {}, action: "log" }] }),
        ),
      ).toThrow(/plane/)
    })

    it("accepts a well-formed semantic rule", () => {
      const rules = parseHooksConfig(
        JSON.stringify({
          rules: [{ id: "r1", plane: "semantic", match: { tool: "Bash" }, action: "hold" }],
        }),
      )
      expect(rules).toEqual([{ id: "r1", plane: "semantic", match: { tool: "Bash" }, action: "hold" }])
    })
  })

  describe('action:"gate"', () => {
    it("accepts a well-formed gate rule and preserves its gate spec", () => {
      const rules = parseHooksConfig(
        JSON.stringify({
          rules: [
            {
              id: "git-push-review-gate",
              plane: "semantic",
              match: { tool: "Bash", command: "^git push" },
              action: "gate",
              gate: { command: "pnpm", args: ["test"] },
            },
          ],
        }),
      )
      expect(rules).toEqual([
        {
          id: "git-push-review-gate",
          plane: "semantic",
          match: { tool: "Bash", command: "^git push" },
          action: "gate",
          gate: { command: "pnpm", args: ["test"] },
        },
      ])
    })

    it("throws when action is \"gate\" but gate.command is missing", () => {
      expect(() =>
        parseHooksConfig(
          JSON.stringify({
            rules: [{ id: "bad-gate", plane: "semantic", match: {}, action: "gate" }],
          }),
        ),
      ).toThrow(/gate\.command/)
    })

    it("throws when action is \"gate\" but gate.command is an empty string", () => {
      expect(() =>
        parseHooksConfig(
          JSON.stringify({
            rules: [
              {
                id: "bad-gate-2",
                plane: "semantic",
                match: {},
                action: "gate",
                gate: { command: "" },
              },
            ],
          }),
        ),
      ).toThrow(HooksConfigError)
    })

    it('throws when "gate" is set on a non-"gate" action', () => {
      expect(() =>
        parseHooksConfig(
          JSON.stringify({
            rules: [
              {
                id: "stray-gate",
                plane: "semantic",
                match: {},
                action: "hold",
                gate: { command: "pnpm" },
              },
            ],
          }),
        ),
      ).toThrow(/only valid with action:"gate"/)
    })

    it('refuses to compile a security-intent rule into a Plane-1 (semantic) gate (RISK-0 GUARD)', () => {
      expect(() =>
        parseHooksConfig(
          JSON.stringify({
            rules: [
              {
                id: "sec-gate",
                plane: "semantic",
                intent: "security",
                match: { command: "^rm -rf" },
                action: "gate",
                gate: { command: "pnpm" },
              },
            ],
          }),
        ),
      ).toThrow(/security/i)
    })
  })

  describe("RISK-0 GUARD", () => {
    it("refuses to compile a security-intent rule into a Plane-1 (semantic) hold", () => {
      expect(() =>
        parseHooksConfig(
          JSON.stringify({
            rules: [
              {
                id: "sec-hold",
                plane: "semantic",
                intent: "security",
                match: { command: "^rm -rf" },
                action: "hold",
              },
            ],
          }),
        ),
      ).toThrow(/security/i)
    })

    it("refuses to compile a security-intent rule into a Plane-1 (semantic) deny", () => {
      expect(() =>
        parseHooksConfig(
          JSON.stringify({
            rules: [
              {
                id: "sec-deny",
                plane: "semantic",
                intent: "security",
                match: { command: "^rm -rf" },
                action: "deny",
              },
            ],
          }),
        ),
      ).toThrow(HooksConfigError)
    })

    it('allows a security-intent rule on plane:"blast-radius"', () => {
      const rules = parseHooksConfig(
        JSON.stringify({
          rules: [
            {
              id: "sec-ok",
              plane: "blast-radius",
              intent: "security",
              match: { command: "^rm -rf" },
              action: "deny",
            },
          ],
        }),
      )
      expect(rules).toHaveLength(1)
    })

    it('allows a security-intent rule with action:"log" on plane:"semantic"', () => {
      const rules = parseHooksConfig(
        JSON.stringify({
          rules: [
            {
              id: "sec-log",
              plane: "semantic",
              intent: "security",
              match: { command: "^rm -rf" },
              action: "log",
            },
          ],
        }),
      )
      expect(rules).toHaveLength(1)
    })
  })

  describe("decide()", () => {
    it("returns allow when no rules match and fallback is allow (unchanged default behavior)", () => {
      expect(decide([], { tool: "Bash", command: "ls" }, "allow")).toBe("allow")
    })

    it("returns hold when no rules match and fallback is hold (permissionHold preserved)", () => {
      expect(decide([], { tool: "Bash", command: "ls" }, "hold")).toBe("hold")
    })

    it("a log-only rule table never overrides the fallback", () => {
      const rules: HookRule[] = [{ id: "log-all", plane: "semantic", match: {}, action: "log" }]
      expect(decide(rules, { tool: "Bash", command: "git push" }, "hold")).toBe("hold")
      expect(decide(rules, { tool: "Bash", command: "git push" }, "allow")).toBe("allow")
    })

    it("a matching non-log rule wins over the fallback", () => {
      const rules: HookRule[] = [
        {
          id: "gate-push",
          plane: "semantic",
          match: { tool: "Bash", command: "^git push" },
          action: "hold",
        },
      ]
      expect(decide(rules, { tool: "Bash", command: "git push origin main" }, "allow")).toBe(
        "hold",
      )
      expect(decide(rules, { tool: "Bash", command: "git status" }, "allow")).toBe("allow")
    })

    it("ignores blast-radius rules at this (Plane-1) seam", () => {
      const rules: HookRule[] = [
        { id: "sandbox-rule", plane: "blast-radius", match: { tool: "Bash" }, action: "deny" },
      ]
      expect(decide(rules, { tool: "Bash", command: "anything" }, "allow")).toBe("allow")
    })

    it("matches argv positionally", () => {
      const rules: HookRule[] = [
        { id: "argv-rule", plane: "semantic", match: { tool: "Bash", argv: ["push"] }, action: "hold" },
      ]
      expect(
        decide(rules, { tool: "Bash", command: "git push", args: ["push"] }, "allow"),
      ).toBe("hold")
      expect(
        decide(rules, { tool: "Bash", command: "git status", args: ["status"] }, "allow"),
      ).toBe("allow")
    })

    it('the canonical git-push gate rule matches "git push" and not other Bash commands', () => {
      const rules: HookRule[] = [
        {
          id: "git-push-review-gate",
          plane: "semantic",
          match: { tool: "Bash", command: "^git push" },
          action: "gate",
          gate: { command: "pnpm", args: ["test"] },
        },
      ]
      expect(decide(rules, { tool: "Bash", command: "git push origin main" }, "allow")).toBe(
        "gate",
      )
      expect(decide(rules, { tool: "Bash", command: "git status" }, "allow")).toBe("allow")
      expect(decide(rules, { tool: "Bash", command: "rm -rf /" }, "allow")).toBe("allow")
    })
  })

  describe("decideRule()", () => {
    it("returns no rule when nothing matches (falls through to fallback)", () => {
      expect(decideRule([], { tool: "Bash", command: "ls" }, "allow")).toEqual({
        decision: "allow",
      })
    })

    it("returns the matched rule alongside its decision", () => {
      const rules: HookRule[] = [
        { id: "gate-push", plane: "semantic", match: { tool: "Bash", command: "^git push" }, action: "hold" },
      ]
      expect(decideRule(rules, { tool: "Bash", command: "git push" }, "allow")).toEqual({
        decision: "hold",
        rule: rules[0],
      })
    })

    it("surfaces a gate rule's gate spec so the caller can actually run it", () => {
      const gateRule: HookRule = {
        id: "git-push-review-gate",
        plane: "semantic",
        match: { tool: "Bash", command: "^git push" },
        action: "gate",
        gate: { command: "pnpm", args: ["test"] },
      }
      const result = decideRule([gateRule], { tool: "Bash", command: "git push origin main" }, "allow")
      expect(result.decision).toBe("gate")
      expect(result.rule?.gate).toEqual({ command: "pnpm", args: ["test"] })
    })
  })
})
