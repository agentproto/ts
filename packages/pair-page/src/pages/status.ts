/**
 * `/d/<id>` — the state page for one paired daemon: registers the pairing's
 * service worker, follows its tunnel state (the worker owns the one
 * connection; this page only asks it), and opens the Control Center as soon
 * as the tunnel is up. The worker sends the Control Center back here when the
 * daemon goes offline, revokes this device, or the pairing is outdated.
 *
 * Also catches `/d/<id>/…` loaded while no worker controls it (first visit in
 * a new tab, site data cleared): the worker is installed, then the same URL is
 * loaded again through it.
 */

import { daemonOrigin } from "../lib/host"
import { controlCenterUrl, isPairWorkerStatus, isPairingId, pairingScope, type PairState } from "../lib/pair"
import {
  currentMode,
  forgetPairing,
  pairStore,
  postToWorker,
  registerPairingWorker,
  serviceWorkersSupported,
} from "../lib/worker-client"
import { button, code, errorText, fingerprint, howToPair, linkButton, p, render, shell } from "../ui/dom"

/** How often to ask the worker for its state. Each message also keeps a worker
 *  that would otherwise idle out alive while this page waits on it. */
const POLL_MS = 2_500

type View = { state: PairState | "loading" | "error"; error?: { code: string; message: string } }

/** Only ever send the user back inside this pairing's own scope. */
function resolveNext(id: string, fromQuery: string | null, here: string | null): string {
  for (const candidate of [fromQuery, here]) {
    if (candidate && candidate.startsWith(pairingScope(id)) && !candidate.includes("//")) return candidate
  }
  return controlCenterUrl(id)
}

function isPairState(s: string | null): s is PairState {
  return (
    s === "connecting" ||
    s === "open" ||
    s === "offline" ||
    s === "revoked" ||
    s === "not_paired" ||
    s === "outdated"
  )
}

export function startStatusPage(root: HTMLElement, id: string, deep: boolean): void {
  let name: string | null = null
  let fp: string | null = null
  let reg: ServiceWorkerRegistration | null = null

  const forget = async (): Promise<void> => {
    await forgetPairing(id)
    window.location.replace("/pair")
  }

  // The worker answers every POLL_MS with the same state most of the time.
  // Rebuilding the view on each answer would swap the buttons out from under
  // a tap, so draw only when what's shown changes.
  let shown = ""
  const draw = (view: View): void => {
    const key = JSON.stringify([view.state, view.error?.message ?? "", name, fp])
    if (key === shown) return
    shown = key
    const daemon = name ?? "your daemon"
    switch (view.state) {
      case "loading":
      case "connecting":
      case "closed":
        render(
          root,
          shell(
            { eyebrow: "paired · connecting", title: `Connecting to ${daemon}…`, tone: "warn" },
            fp ? fingerprint(fp) : null,
            p("Opening the end-to-end tunnel through the rendezvous. The Control Center loads from the daemon itself."),
          ),
        )
        return
      case "open":
        render(root, shell({ eyebrow: "connected", title: `Connected to ${daemon}`, tone: "ok" }, p("Opening the Control Center…")))
        return
      case "offline":
        render(
          root,
          shell(
            { eyebrow: "daemon offline · retrying", title: `${daemon} is unreachable`, tone: "danger" },
            p("Retrying on its own. Check that the computer is awake and the daemon is running (", code("agentproto serve"), ")."),
            view.error ? errorText(view.error.message) : null,
            button("Retry now", () => reg && postToWorker(reg, { type: "agentproto-pair:reconnect" }), {
              variant: "secondary",
            }),
          ),
        )
        return
      case "revoked":
        render(
          root,
          shell(
            { eyebrow: "revoked", title: `This phone was unpaired from ${daemon}`, tone: "danger" },
            p("The daemon revoked this device, so it can't reconnect. To use it again, pair from a new QR."),
            ...howToPair(),
            button("Forget this daemon", () => void forget(), { variant: "danger" }),
          ),
        )
        return
      case "outdated":
        render(
          root,
          shell(
            { eyebrow: "not paired · outdated pairing", title: "Pair this phone again", tone: "danger" },
            p(
              `This phone was paired with ${daemon} using an older pairing protocol, which the daemon no longer accepts. Make sure agentproto is up to date on the computer, then pair again from a new QR.`,
            ),
            ...howToPair(),
            button("Forget the old pairing", () => void forget(), { variant: "danger" }),
          ),
        )
        return
      case "not_paired":
        render(
          root,
          shell(
            { eyebrow: "not paired", title: "This phone isn't paired with that daemon" },
            ...howToPair(),
            button("See paired daemons", () => window.location.assign("/pair"), { variant: "secondary" }),
          ),
        )
        return
      case "error":
        render(
          root,
          shell(
            { eyebrow: "error", title: "Couldn't start the Control Center", tone: "danger" },
            errorText(view.error?.message ?? "unknown error"),
          ),
        )
        return
    }
  }

  if (!isPairingId(id)) {
    draw({ state: "not_paired" })
    return
  }
  const mode = currentMode()
  if (mode.kind === "daemon" && mode.fingerprint !== id) {
    // §5.8: this origin never holds or uses another daemon's credential.
    const link = `${daemonOrigin(id, window.location)}/d/${id}`
    render(
      root,
      shell(
        { eyebrow: "wrong address", title: "This address serves another daemon", tone: "danger" },
        p("This address belongs to daemon ", code(mode.fingerprint), " only. Daemon ", code(id), " has its own:"),
        linkButton(`Open ${new URL(link).host}`, link),
      ),
    )
    return
  }
  if (!serviceWorkersSupported()) {
    draw({ state: "error", error: { code: "unsupported", message: "This browser has no service workers." } })
    return
  }

  const search = new URLSearchParams(window.location.search)
  const hinted = search.get("state")
  draw({ state: isPairState(hinted) ? hinted : "loading" })
  const next = resolveNext(id, search.get("next"), deep ? window.location.pathname + window.location.search : null)

  let stopped = false
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const status = event.data
    if (stopped || !isPairWorkerStatus(status) || status.id !== id) return
    if (status.daemonName) name = status.daemonName
    draw(status.error ? { state: status.state, error: status.error } : { state: status.state })
    if (status.state === "open") {
      stopped = true
      window.location.replace(next)
    }
  })
  window.addEventListener("online", () => {
    if (reg) postToWorker(reg, { type: "agentproto-pair:reconnect" })
  })

  void (async () => {
    const credential = await pairStore().get(id)
    if (stopped) return
    if (!credential) {
      draw({ state: "not_paired" })
      return
    }
    name = credential.name
    fp = credential.fingerprint
    reg = await registerPairingWorker(id)
    if (stopped) return
    const poll = (): void => {
      if (reg) postToWorker(reg, { type: "agentproto-pair:status" })
    }
    poll()
    setInterval(poll, POLL_MS)
  })().catch(err => {
    if (!stopped) draw({ state: "error", error: { code: "error", message: err instanceof Error ? err.message : String(err) } })
  })
}
