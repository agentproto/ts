/**
 * `/pair` — first contact. Reads the offer from the fragment (what `agentproto
 * pair offer --qr` links to), runs the E2E handshake through the rendezvous,
 * asks the user to confirm the daemon's name and fingerprint, stores the
 * credential and opens the daemon's status page. With no offer, lists this
 * origin's pairing (one at most on a daemon origin).
 */

import {
  connect,
  inspectOffer,
  pairFromOffer,
  TunnelClientError,
  type PairCredential,
  type PendingPairing,
} from "@agentproto/pairing"
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

  const waitingView = (pending: PendingPairing): HTMLElement => {
    const daemon = pending.daemon
    return shell(
      { eyebrow: "waiting for confirmation", title: `Approve this phone on ${daemon.name}`, tone: "warn" },
      p("On the computer, compare this code with the one the daemon shows:"),
      h("div", { class: "fingerprint" }, code(pending.code)),
      p("Daemon:"),
      fingerprint(daemon.fingerprint),
      p(
        "Then confirm on the computer with ",
        code(`agentproto pair confirm ${pending.code}`),
        ". Nothing is saved on this phone until then.",
      ),
    )
  }

  const waitForApproval = async (pending: PendingPairing, expiresAt: Date): Promise<void> => {
    const credential = await pending.credential()
    const client = connect(credential, {
      handshakeTimeoutMs: 5_000,
      reconnectMinMs: 500,
      reconnectMaxMs: 3_000,
      requestWaitMs: 15_000,
    })
    try {
      for (;;) {
        if (Date.now() >= expiresAt.getTime()) {
          throw new TunnelClientError(
            "pairing_failed",
            "this pairing request expired before it was confirmed; get a fresh QR from the computer",
          )
        }
        try {
          await client.ready()
          break
        } catch (err) {
          const terminal =
            err instanceof TunnelClientError &&
            (err.code === "revoked" || err.code === "protocol_outdated" || err.code === "closed")
          if (terminal) throw err
          // Still pending on the daemon: retry until the offer expires.
          await new Promise(resolve => setTimeout(resolve, 1_000))
        }
      }
      await pairStore().put(credential)
      client.close()
      const reg = await registerPairingWorker(credential.id)
      // A worker already running for this daemon (a re-pair after a revoke
      // or an outdated pairing) still holds the old credential's client.
      postToWorker(reg, { type: "agentproto-pair:reset" })
      window.location.replace(statusPath(credential.id))
    } catch (err) {
      client.close()
      show(errorView(err))
    }
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
      show(waitingView(pending))
      await waitForApproval(pending, info.expiresAt)
    } catch (err) {
      show(errorView(err))
    }
  })()
}
