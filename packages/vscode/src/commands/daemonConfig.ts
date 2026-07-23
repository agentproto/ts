/**
 * agentproto.showDaemonConfig — the "Daemon Configuration" surface.
 *
 * A distinct surface from the VS Code `agentproto.*` settings.json keys: those
 * configure how the EXTENSION talks to the daemon; this reads/edits the
 * DAEMON'S OWN behavior knobs, which live in `~/.agentproto/config.json`
 * `daemon.*` and are otherwise only reachable via `agentproto config set`.
 *
 * Shape mirrors the other pickers in this package (sessionConfig.ts): a
 * QuickPick lists each knob with its effective/persisted value; picking an
 * editable knob edits it; a "Restart daemon" row appears whenever an edit is
 * pending (a boot-time knob written but not yet booted). All decisions are
 * pure (daemonConfig.logic.ts); this file is the shell + I/O.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import { readConfigFile, writeConfigFile } from "../daemonConfig/daemonConfigFile.js"
import {
  anyRestartPending,
  buildConfigView,
  formatKnobValue,
  normalizeIdleReapInput,
  parseDaemonSection,
  parseEffectiveKnobs,
  setConfigKey,
  type KnobRow,
} from "../daemonConfig/daemonConfig.logic.js"

const RESTART_COMMAND = "agentproto daemon restart"

export function registerDaemonConfig(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.showDaemonConfig", () =>
      showDaemonConfig(client),
    ),
  )
}

interface KnobItem extends vscode.QuickPickItem {
  action: { kind: "edit"; row: KnobRow } | { kind: "restart" }
}

async function showDaemonConfig(client: DaemonClient): Promise<void> {
  let rows: KnobRow[]
  try {
    // Effective (live) values from the daemon; persisted values from the file
    // it reads at boot. Health failure is non-fatal — fall back to persisted
    // only, so the surface still opens against a stopped daemon.
    const [health, configRaw] = await Promise.all([
      client.health().catch(() => undefined),
      readConfigFile(),
    ])
    rows = buildConfigView(parseDaemonSection(configRaw), parseEffectiveKnobs(health))
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: could not read daemon configuration: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return
  }

  const items: KnobItem[] = rows.map(row => {
    const pending = row.restartPending
      ? `  ·  ⚠ ${formatKnobValue(row.persisted ?? row.spec.defaultValue)} pending — restart to apply`
      : ""
    const boot = row.spec.bootTime ? "$(watch) applies at daemon boot" : ""
    return {
      label: `${row.spec.editable ? "$(edit) " : ""}${row.spec.label}`,
      description: `${formatKnobValue(row.displayValue)}${pending}`,
      detail: [boot, row.spec.editable ? "" : "read-only (edit via agentproto config set)"]
        .filter(Boolean)
        .join("  ·  "),
      action: { kind: "edit", row },
    }
  })

  if (anyRestartPending(rows)) {
    items.unshift({
      label: "$(debug-restart) Restart daemon",
      description: "apply pending boot-time changes",
      detail: `runs \`${RESTART_COMMAND}\` in a terminal`,
      action: { kind: "restart" },
    })
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: "agentproto: Daemon Configuration",
    placeHolder: "Daemon-side behavior knobs (~/.agentproto/config.json) — distinct from the extension's settings",
  })
  if (!pick) return

  if (pick.action.kind === "restart") {
    restartDaemon()
    return
  }

  const { row } = pick.action
  if (!row.spec.editable) {
    vscode.window.showInformationMessage(
      `agentproto: "${row.spec.label}" is read-only here — edit it with \`agentproto config set ${row.spec.dotted} <value>\`.`,
    )
    return
  }

  const applied = await editKnob(row)
  if (applied) {
    // Re-open so the freshly-written value (and the now-available Restart row)
    // show without the user re-invoking the command.
    await showDaemonConfig(client)
  }
}

/** Edit one of the two behavior knobs, writing the result to config.json.
 *  Returns true when a value was written. */
async function editKnob(row: KnobRow): Promise<boolean> {
  let value: boolean | number
  if (row.spec.kind === "boolean") {
    const current = row.displayValue === true
    const choice = await vscode.window.showQuickPick(
      [
        { label: "$(check) On", value: true, picked: current },
        { label: "$(circle-slash) Off", value: false, picked: !current },
      ],
      { title: row.spec.label, placeHolder: `Currently ${current ? "on" : "off"}` },
    )
    if (!choice) return false
    value = choice.value
  } else {
    const input = await vscode.window.showInputBox({
      title: row.spec.label,
      prompt: "Idle threshold in milliseconds before an idle agent session is reaped (0 = off)",
      value: String(row.displayValue ?? 0),
      validateInput: raw => {
        const parsed = normalizeIdleReapInput(raw)
        return parsed.ok ? undefined : parsed.error
      },
    })
    if (input === undefined) return false
    const parsed = normalizeIdleReapInput(input)
    if (!parsed.ok) return false // validateInput already surfaced the error
    value = parsed.value
  }

  try {
    const config = await readConfigFile()
    await writeConfigFile(setConfigKey(config, row.spec.dotted, value))
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: could not write ${row.spec.dotted}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }

  // Every knob here is boot-time, so name the restart requirement explicitly.
  const action = await vscode.window.showInformationMessage(
    `agentproto: set ${row.spec.dotted} = ${formatKnobValue(value)}. This is a boot-time knob — restart the daemon to apply.`,
    "Restart daemon",
  )
  if (action === "Restart daemon") restartDaemon()
  return true
}

/** Reuse the CLI's `daemon restart` (launchctl kickstart -k) via a terminal —
 *  the same pattern authProfiles.ts uses for the login flow. */
function restartDaemon(): void {
  const terminal = vscode.window.createTerminal({ name: "agentproto: daemon restart" })
  terminal.show(true)
  terminal.sendText(RESTART_COMMAND)
}
