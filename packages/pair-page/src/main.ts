/**
 * Entry point of the pair page bundle. One document (index.html) serves every
 * route; the edge Worker hands it out for `/`, `/pair` and `/d/*`:
 *
 *   /pair, /          the pair page (src/pages/pair.ts)
 *   /d/<id>[/…]       the daemon's status page (src/pages/status.ts); under a
 *                     controlled scope the service worker answers instead
 */

import "./styles.css"
import { startPairPage } from "./pages/pair"
import { startStatusPage } from "./pages/status"
import { h, p, render, setPreviewBanner, shell } from "./ui/dom"
import { currentMode } from "./lib/worker-client"

const root = document.getElementById("app") ?? document.body.appendChild(h("main", {}))

if (currentMode().kind === "preview") {
  setPreviewBanner(
    `PREVIEW (${window.location.host}): not a daemon's own address. Every pairing made here shares this origin; use it for testing only.`,
  )
}

const path = window.location.pathname
const daemon = /^\/d\/([^/]+)(\/.*)?$/.exec(path)

if (path === "/" || path === "/pair" || path === "/pair/") {
  startPairPage(root)
} else if (daemon) {
  startStatusPage(root, daemon[1]!.toLowerCase(), (daemon[2] ?? "").length > 1)
} else {
  render(root, shell({ eyebrow: "not found", title: "Nothing here" }, p("Open the pairing link from your daemon's QR code.")))
}
