/**
 * connect-machines — the pairing-direction wizard (recap E9).
 *
 * `agentproto pair offer --host` sent from A and accepted on B registers B
 * as a CLIENT of A, and "no host matched" is what the operator sees when the
 * roles end up inverted. Its direction is genuinely counter-intuitive: this
 * step asks WHICH direction the operator wants and prints the EXACT commands
 * for the two roles, rather than leaving the meaning of the flags to be
 * discovered across three failed pairing attempts.
 *
 * `agentproto pair offer`            (CLIENT offer) pairs the OTHER machine
 *   as a remote-control client of THIS daemon.
 * `agentproto pair offer --host`     (HOST offer, minted HERE when this
 *   machine should be PILOTED) — the offer URL must be accepted/added ON the
 *   CONTROLLER machine (`agentproto pair accept` there, or
 *   `agentproto devices add <url>` to register it as a driveable host).
 *
 * Always optional (required: false), and it is `skipped` once at least one
 * device is paired: the wizard then never prompts again.
 */

import type { DeviceSnapshot, OnboardingStep, SetupAction, StepCheck, StepContext } from "../types.js"

export const CHECK_ID = "connect-machines.direction"
/** One line per direction, printed after the operator picks (apply + report). */
export function directionCommands(direction: "pilot" | "pilotable" | "skip", homeMachineLabel = "this machine"): string {
  switch (direction) {
    case "pilot":
      return (
        `Pilot other machines from ${homeMachineLabel}:\n` +
        `1. On the OTHER machine: agentproto pair offer\n` +
        `2. Back here: agentproto pair accept <offer-url>\n` +
        `The other machine becomes a remote-control client of this daemon.`
      )
    case "pilotable":
      return (
        `Let another machine drive ${homeMachineLabel}:\n` +
        `1. On THIS machine: agentproto pair offer --host\n` +
        `2. On the CONTROLLER machine: agentproto devices add <offer-url>\n` +
        `The offer must be accepted/added on the CONTROLLER, not here — host-scoped offers are never meant for this side's accept.`
      )
    case "skip":
      return `Skip — no machines connected.`
  }
}

/** SetupChoice ids surfaced by this step's plan. */
export const DIRECTIONS = {
  pilot: "pilot-others",
  pilotable: "be-pilotable",
  skip: "skip",
} as const

export const connectMachinesStep: OnboardingStep = {
  id: "connect-machines",
  title: "Connect machines",
  required: false,
  async detect(ctx): Promise<StepCheck[]> {
    let devices: DeviceSnapshot[]
    try {
      devices = await ctx.sources.loadDevices()
    } catch (err) {
      return [
        { id: CHECK_ID, title: "Connect machines", status: "warn", detail: `not checked: ${String(err)}` },
      ]
    }
    if (devices.length > 0) {
      return [
        { id: CHECK_ID, title: "Connect machines", status: "ok", detail: `${devices.length} device(s) paired`, data: { count: devices.length } },
      ]
    }
    return [
      {
        id: CHECK_ID,
        title: "Connect machines",
        // warn (never fails, even though the step itself is optional): this is
        // the wizard's "propose" trigger — nothing is paired yet, and
        // connecting one is a manual choice the doctor just surfaces.
        status: "warn",
        detail: "no machines paired — connect one to drive this machine remotely, or keep it standalone",
        data: { count: 0 },
      },
    ]
  },
  async plan(checks): Promise<SetupAction[]> {
    const main = checks.find((c) => c.id === CHECK_ID)
    if (!main || main.status !== "warn") return []
    return [
      {
        id: "connect-machines.direction",
        title: "Should this machine pilot other machines, or be piloted?",
        default: true,
        choices: [
          {
            value: DIRECTIONS.pilot,
            label: "Pilot other machines (run agents here, billed here)",
            hint: "pair offer (client offer) on one side, pair accept on this side",
            default: false,
          },
          {
            value: DIRECTIONS.pilotable,
            label: "Be piloted (this machine's sessions are driven remotely)",
            hint: "this side runs `agentproto pair offer --host`; the offer URL is accepted/added on the CONTROLLER",
            default: false,
          },
          {
            value: DIRECTIONS.skip,
            label: "Skip — connect later or never",
            default: true,
          },
        ],
        // Printing is the whole point — never applied unattended.
        async apply(io, selected = []) {
          const direction = selected.includes(DIRECTIONS.pilot)
            ? "pilot"
            : selected.includes(DIRECTIONS.pilotable)
              ? "pilotable"
              : "skip"
          const text = directionCommands(direction)
          if (direction !== "skip") {
            // The wizard prints the exact commands where the operator is
            // reading them; it never runs `pair offer/accept` itself.
            io.log.message(text)
          }
          return {
            ok: true,
            detail: direction === "skip" ? "skipped" : "commands printed above",
          }
        },
      },
    ]
  },
}
