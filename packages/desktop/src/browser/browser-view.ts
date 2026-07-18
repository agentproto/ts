// Derive the browser tabs to show for a selected session. A tab comes from any
// session that carries browser fields (its own browserBaseUrl/browserPort) —
// the selected session plus any of its child browser sessions. One tab per
// agent browser session, per the SPEC.

import type { BrowserTab, SessionDescriptor } from "../data/types"
import { sessionTitle } from "../data/session-view"

function browserUrl(s: SessionDescriptor): string | null {
  if (s.browserBaseUrl) return s.browserBaseUrl
  if (typeof s.browserPort === "number") return `localhost:${s.browserPort}`
  return null
}

/** A session exposes a browser surface when it has a base url or a port. */
function hasBrowser(s: SessionDescriptor): boolean {
  return browserUrl(s) !== null
}

function toTab(s: SessionDescriptor): BrowserTab | null {
  const url = browserUrl(s)
  if (!url) return null
  const title = s.kind === "browser" ? sessionTitle(s) : `${sessionTitle(s)} · browser`
  return { id: `${s.id}:browser`, url, title }
}

/**
 * Browser tabs for the selected session: its own browser surface first, then
 * any child sessions that expose one. De-duplicated by tab id.
 */
export function browserTabsFor(
  selected: SessionDescriptor,
  all: readonly SessionDescriptor[],
): BrowserTab[] {
  const candidates: SessionDescriptor[] = [selected]
  for (const s of all) {
    if (s.id !== selected.id && s.parentSessionId === selected.id && hasBrowser(s)) {
      candidates.push(s)
    }
  }
  const seen = new Set<string>()
  const tabs: BrowserTab[] = []
  for (const s of candidates) {
    const tab = toTab(s)
    if (tab && !seen.has(tab.id)) {
      seen.add(tab.id)
      tabs.push(tab)
    }
  }
  return tabs
}
