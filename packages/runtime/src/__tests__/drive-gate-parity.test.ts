/**
 * Byte-equal parity table for the drive gate, captured from the UNMODIFIED
 * `checkSessionOwnerGate` before the drive tools routed through `decide()`.
 *
 * Each row is `[key, ok, message]` where `key` is `<caller>|<tool>`. The
 * test re-evaluates every row through `checkDrive` with no grants, with an
 * empty grants list, and with a non-matching `session:prompt` /
 * `session:control` grant. All three must reproduce the legacy table byte
 * for byte, so a grant can only change an outcome when it actually matches.
 */

import { describe, expect, it } from "vitest"
import type { Grant } from "@agentproto/policy"

import { checkDrive, DRIVE_TOOL_ACTIONS } from "../drive-gate.js"
import { checkSessionOwnerGate } from "../session-owner.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

type Row = [key: string, ok: boolean, message: string | null]

type Session = {
  id: string
  parentSessionId?: string
  operatorLabel?: string
}

const REG: Record<string, Session> = {
  root: { id: "root" },
  parent: { id: "parent", parentSessionId: "root" },
  target: { id: "target", parentSessionId: "parent" },
  stranger: { id: "stranger" },
  allowed: { id: "allowed" },
  labeled: { id: "labeled", operatorLabel: "brain" },
  labeled_child: { id: "labeled_child", parentSessionId: "labeled", operatorLabel: "brain" },
  unlabeled: { id: "unlabeled" },
}

const BASE = { id: "target", parentSessionId: "parent" }
const TARGETS = {
  base: BASE,
  allowId: { ...BASE, allowPromptFrom: ["allowed"] },
  any: { ...BASE, allowPromptFrom: ["any"] },
  label: { ...BASE, allowPromptFrom: ["label:brain"] },
  labelPrefix: { ...BASE, allowPromptFrom: ["label:bra*"] },
}

const CALLERS: Array<[caller: string, id: string | undefined, target: keyof typeof TARGETS]> = [
  ["operator", undefined, "base"],
  ["self", "target", "base"],
  ["parent", "parent", "base"],
  ["grandparent", "root", "base"],
  ["stranger", "stranger", "base"],
  ["allow-id", "allowed", "allowId"],
  ["any", "stranger", "any"],
  ["label-exact", "labeled", "label"],
  ["label-prefix", "labeled", "labelPrefix"],
  ["labeled-with-parent", "labeled_child", "label"],
  ["unlabeled", "unlabeled", "label"],
  ["unknown", "unknown", "base"],
]

const TABLE: Row[] = [
  ["operator|agent_prompt", true, null],
  ["operator|agent_interrupt", true, null],
  ["operator|agent_kill", true, null],
  ["operator|session_restart", true, null],
  ["operator|session_continue_fresh", true, null],
  ["self|agent_prompt", true, null],
  ["self|agent_interrupt", true, null],
  ["self|agent_kill", true, null],
  ["self|session_restart", true, null],
  ["self|session_continue_fresh", true, null],
  ["parent|agent_prompt", true, null],
  ["parent|agent_interrupt", true, null],
  ["parent|agent_kill", true, null],
  ["parent|session_restart", true, null],
  ["parent|session_continue_fresh", true, null],
  ["grandparent|agent_prompt", true, null],
  ["grandparent|agent_interrupt", true, null],
  ["grandparent|agent_kill", true, null],
  ["grandparent|session_restart", true, null],
  ["grandparent|session_continue_fresh", true, null],
  ["stranger|agent_prompt", false, "agent_prompt: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"stranger\", which is none of those."],
  ["stranger|agent_interrupt", false, "agent_interrupt: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"stranger\", which is none of those."],
  ["stranger|agent_kill", false, "agent_kill: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"stranger\", which is none of those."],
  ["stranger|session_restart", false, "session_restart: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"stranger\", which is none of those."],
  ["stranger|session_continue_fresh", false, "session_continue_fresh: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"stranger\", which is none of those."],
  ["allow-id|agent_prompt", true, null],
  ["allow-id|agent_interrupt", true, null],
  ["allow-id|agent_kill", true, null],
  ["allow-id|session_restart", true, null],
  ["allow-id|session_continue_fresh", true, null],
  ["any|agent_prompt", true, null],
  ["any|agent_interrupt", true, null],
  ["any|agent_kill", true, null],
  ["any|session_restart", true, null],
  ["any|session_continue_fresh", true, null],
  ["label-exact|agent_prompt", true, null],
  ["label-exact|agent_interrupt", true, null],
  ["label-exact|agent_kill", true, null],
  ["label-exact|session_restart", true, null],
  ["label-exact|session_continue_fresh", true, null],
  ["label-prefix|agent_prompt", true, null],
  ["label-prefix|agent_interrupt", true, null],
  ["label-prefix|agent_kill", true, null],
  ["label-prefix|session_restart", true, null],
  ["label-prefix|session_continue_fresh", true, null],
  ["labeled-with-parent|agent_prompt", false, "agent_prompt: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"labeled_child\", which is none of those."],
  ["labeled-with-parent|agent_interrupt", false, "agent_interrupt: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"labeled_child\", which is none of those."],
  ["labeled-with-parent|agent_kill", false, "agent_kill: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"labeled_child\", which is none of those."],
  ["labeled-with-parent|session_restart", false, "session_restart: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"labeled_child\", which is none of those."],
  ["labeled-with-parent|session_continue_fresh", false, "session_continue_fresh: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"labeled_child\", which is none of those."],
  ["unlabeled|agent_prompt", false, "agent_prompt: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unlabeled\", which is none of those."],
  ["unlabeled|agent_interrupt", false, "agent_interrupt: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unlabeled\", which is none of those."],
  ["unlabeled|agent_kill", false, "agent_kill: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unlabeled\", which is none of those."],
  ["unlabeled|session_restart", false, "session_restart: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unlabeled\", which is none of those."],
  ["unlabeled|session_continue_fresh", false, "session_continue_fresh: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unlabeled\", which is none of those."],
  ["unknown|agent_prompt", false, "agent_prompt: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unknown\", which is none of those."],
  ["unknown|agent_interrupt", false, "agent_interrupt: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unknown\", which is none of those."],
  ["unknown|agent_kill", false, "agent_kill: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unknown\", which is none of those."],
  ["unknown|session_restart", false, "session_restart: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unknown\", which is none of those."],
  ["unknown|session_continue_fresh", false, "session_continue_fresh: session \"target\" may only be driven by its owner \u2014 the session that spawned it (parent) \u2014 one of its ancestors in the spawn tree, by the human operator, or by a caller explicitly granted access via `allowPromptFrom`. This call came from session \"unknown\", which is none of those."],
]

const REGISTRY = { get: (id: string) => REG[id] } as unknown as Pick<SessionsRegistry, "get">

const NON_MATCHING: Grant[] = [
  { principal: "*", effect: "allow", actions: [{ action: "session:prompt", scope: "nowhere" }] },
  { principal: "*", effect: "allow", actions: [{ action: "session:control", scope: "nowhere" }] },
]

const CASES: Array<[name: string, grants: readonly Grant[] | undefined]> = [
  ["no grants", undefined],
  ["empty grants", []],
  ["non-matching grants", NON_MATCHING],
]

describe("drive gate parity with the legacy owner gate", () => {
  for (const [caseName, grants] of CASES) {
    it(`reproduces every legacy row byte for byte (${caseName})`, () => {
      const actual: Row[] = []
      for (const [callerName, callerId, targetKey] of CALLERS) {
        for (const tool of Object.keys(DRIVE_TOOL_ACTIONS)) {
          const target = TARGETS[targetKey] as unknown as SessionDescriptor
          const r = checkDrive({
            registry: REGISTRY,
            ...(grants !== undefined ? { grants } : {}),
            callerSessionId: callerId,
            target,
            tool,
          })
          actual.push([`${callerName}|${tool}`, r.ok, r.ok ? null : r.message])
        }
      }
      expect(actual).toEqual(TABLE)
    })
  }
})

describe("the table is the legacy owner gate", () => {
  // The five drive tools used to call `checkSessionOwnerGate` directly with
  // the registry lookups below. Evaluating the table through that function
  // pins that it records the legacy gate itself, not only what `checkDrive`
  // happens to answer today.
  it("reproduces every row through checkSessionOwnerGate", () => {
    const actual: Row[] = []
    for (const [callerName, callerId, targetKey] of CALLERS) {
      for (const tool of Object.keys(DRIVE_TOOL_ACTIONS)) {
        const r = checkSessionOwnerGate({
          callerSessionId: callerId,
          target: TARGETS[targetKey],
          tool,
          parentOf: id => REG[id]?.parentSessionId,
          operatorLabelOf: id => REG[id]?.operatorLabel,
        })
        actual.push([`${callerName}|${tool}`, r.ok, r.ok ? null : r.message])
      }
    }
    expect(actual).toEqual(TABLE)
  })
})
