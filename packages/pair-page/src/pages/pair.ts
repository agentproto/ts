/**
 * `/pair` — first contact. Reads the offer from the fragment (what `agentproto
 * pair offer --qr` links to), runs the E2E handshake through the rendezvous,
 * asks the user to confirm the daemon's name and fingerprint, stores the
 * credential and opens the daemon's status page. With no offer, lists this
 * origin's pairing (one at most on a daemon origin).
 */

import {
  inspectOffer,
  pairFromOffer,
  TunnelClientError,
  type PairCredential,
  type PairedDaemon,
  type PendingPairing,
} from "@agentproto/pair-client"
import { daemonOrigin } from "../lib/host"
import { isOutdatedPairingError, statusPath } from "../lib/pair"
import {
  currentMode,
  forgetPairing,
  pairStore,
  postToWorker,
  registerPairingWorker,
  serviceWorkersSupported,
} from "../lib/worker-client"
import { button, code, errorText, fingerprint, h, howToPair, linkButton, p, render, row, shell } from "../ui/dom"

const OFFER_PREFIX = "agentproto://pair?"

/**
 * Read the offer out of the fragment (`/pair#v=2&rv=…`) and wipe it from the
 * address bar and history right away, before anything else runs. The fragment
 * is the query string of an `agentproto://pair?…` offer; it never reached a
 * server.
 */
function takeOfferFromFragment(): string | null {
  const fragment = window.location.hash.replace(/^#/, "")
  if (!fragment) return null
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
  return `${OFFER_PREFIX}${fragment}`
}

/** How this phone is listed on the daemon (`agentproto pair ls`). */
function deviceName(): string {
  const ua = navigator.userAgent
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null
  return device ? `${device} browser (${window.location.host})` : `browser@${window.location.host}`
}

function errorView(err: unknown): HTMLElement {
  const message = err instanceof Error ? err.message : String(err)
  if (isOutdatedPairingError(err)) {
    return shell(
      { eyebrow: "pairing failed", title: "This pairing link is from an older agentproto", tone: "danger" },
      errorText(message),
      p("Update agentproto on the computer, then get a new pairing link:"),
      ...howToPair(),
    )
  }
  let title = "Something went wrong"
  if (err instanceof TunnelClientError && err.code === "invalid_offer") title = "This pairing link is invalid or expired"
  if (err instanceof TunnelClientError && err.code === "pairing_failed") title = "Pairing failed"
  return shell(
    { eyebrow: "pairing failed", title, tone: "danger" },
    errorText(message),
    p("Pairing links are single-use and expire after a few minutes. Get a fresh one:"),
    ...howToPair(),
  )
}

/** The offer is for another daemon than this origin's (§5.8): refused before
 *  any network I/O, so the offer is still unspent on its own origin. */
function wrongAddressView(here: string, offered: string, offer: string): HTMLElement {
  const link = `${daemonOrigin(offered, window.location)}/pair#${offer.slice(OFFER_PREFIX.length)}`
  return shell(
    { eyebrow: "wrong address", title: "This pairing link is for a different daemon", tone: "danger" },
    p("This address pairs daemon ", code(here), " only. The QR you scanned is for daemon:"),
    fingerprint(offered),
    p("Nothing was saved. Open the pairing link on that daemon's own address:"),
    linkButton(`Open ${new URL(link).host}`, link),
  )
}

export function startPairPage(root: HTMLElement): void {
  const mode = currentMode()
  const show = (view: HTMLElement): void => render(root, view)

  // An offer link opened while this page is already showing is only a
  // fragment change (no load): start over so it is read like a fresh scan.
  window.addEventListener("hashchange", () => {
    if (window.location.hash.length > 1) window.location.reload()
  })

  const offer = takeOfferFromFragment()
  if (!serviceWorkersSupported()) {
    show(
      shell(
        { eyebrow: "agentproto pair", title: "This browser can't host the Control Center", tone: "danger" },
        p(
          "Pairing needs service workers, which this browser (or this private window) doesn't offer. Open the pairing link in Safari or Chrome.",
        ),
      ),
    )
    return
  }

  const loadHome = async (): Promise<void> => {
    const pairings = await pairStore().list()
    const launch = new URLSearchParams(window.location.search).get("launch") === "1"
    // Home-screen launch with a single daemon: straight to it.
    if (launch && pairings.length === 1) {
      window.location.replace(statusPath(pairings[0]!.id))
      return
    }
    show(homeView(pairings))
  }

  const homeView = (pairings: PairCredential[]): HTMLElement => {
    if (pairings.length === 0) {
      const title =
        mode.kind === "daemon"
          ? `Pair this phone with daemon ${mode.fingerprint}`
          : "Pair this phone with your agentproto daemon"
      return shell({ eyebrow: "not paired", title }, ...howToPair())
    }
    return shell(
      { eyebrow: "paired daemons", title: "Open the Control Center", tone: "ok" },
      h(
        "ul",
        { class: "list" },
        ...pairings.map(c =>
          h(
            "li",
            {},
            h("div", { class: "name" }, c.name),
            h("div", { class: "fp" }, c.fingerprint),
            row(
              button("Open", () => window.location.assign(statusPath(c.id))),
              button(
                "Forget",
                () => {
                  void forgetPairing(c.id).then(loadHome)
                },
                { variant: "secondary" },
              ),
            ),
          ),
        ),
      ),
    )
  }

  const confirmView = (pending: PendingPairing, saving: boolean): HTMLElement => {
    const daemon = pending.daemon
    return shell(
      { eyebrow: "confirm pairing", title: `Pair with ${daemon.name}?`, tone: "warn" },
      p("Check that this fingerprint matches the one printed by ", code("agentproto pair offer"), ":"),
      fingerprint(daemon.fingerprint),
      daemon.platform ? h("p", { class: "error-text" }, daemon.platform) : null,
      row(
        button(saving ? "Pairing…" : "Confirm", () => void confirm(pending), { disabled: saving }),
        button("Cancel", () => cancel(pending), { variant: "secondary", disabled: saving }),
      ),
    )
  }

  const confirm = async (pending: PendingPairing): Promise<void> => {
    show(confirmView(pending, true))
    try {
      const credential = await pending.confirm()
      const reg = await registerPairingWorker(credential.id)
      // A worker already running for this daemon (a re-pair after a revoke
      // or an outdated pairing) still holds the old credential's client.
      postToWorker(reg, { type: "agentproto-pair:reset" })
      window.location.replace(statusPath(credential.id))
    } catch (err) {
      show(errorView(err))
    }
  }

  const cancel = (pending: PendingPairing): void => {
    pending.cancel()
    const daemon: PairedDaemon = pending.daemon
    show(
      shell(
        { eyebrow: "cancelled", title: "Nothing was saved on this phone" },
        p(
          "The daemon still lists this device. Remove it on the computer with ",
          code(`agentproto pair revoke ${daemon.fingerprint}`),
          ".",
        ),
        button("Done", () => void loadHome(), { variant: "secondary" }),
      ),
    )
  }

  if (!offer) {
    show(shell({ eyebrow: "agentproto pair", title: "Loading…" }))
    void loadHome().catch(err => show(errorView(err)))
    return
  }

  void (async () => {
    try {
      // No network: parse and validate what the QR says.
      const info = await inspectOffer(offer)
      if (mode.kind === "daemon" && info.fingerprint !== mode.fingerprint) {
        show(wrongAddressView(mode.fingerprint, info.fingerprint, offer))
        return
      }
      show(
        shell(
          { eyebrow: "pairing", title: "Reaching the daemon…", tone: "warn" },
          p("The link names this daemon:"),
          fingerprint(info.fingerprint),
          p("Running the end-to-end handshake through the rendezvous."),
        ),
      )
      const pending = await pairFromOffer(offer, { store: pairStore(), clientName: deviceName() })
      // The handshake verified the daemon against the offer's key; checked
      // again anyway so nothing foreign can reach the store.
      if (mode.kind === "daemon" && pending.daemon.fingerprint !== mode.fingerprint) {
        pending.cancel()
        show(wrongAddressView(mode.fingerprint, pending.daemon.fingerprint, offer))
        return
      }
      show(confirmView(pending, false))
    } catch (err) {
      show(errorView(err))
    }
  })()
}
