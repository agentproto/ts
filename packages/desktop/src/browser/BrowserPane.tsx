// Browser view for one agent browser tab: an editable address bar wired to a
// real <iframe> embed, with a small history stack driving back/forward/reload.
// tauri.conf.json ships `csp: null` so the iframe is free to load cross-origin
// content; some sites still refuse via X-Frame-Options/frame-ancestors, which
// shows as a blank frame — that's a site policy, not a bug here.

import { useState, type FormEvent } from "react"
import type { BrowserTab } from "../data/types"

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  return SCHEME_RE.test(trimmed) ? trimmed : `http://${trimmed}`
}

export function BrowserPane({ tab }: { tab: BrowserTab }) {
  // Keyed by tab.id so switching browser tabs remounts this with fresh state
  // instead of carrying over the previous tab's history/url.
  return <BrowserPaneInner key={tab.id} tab={tab} />
}

function BrowserPaneInner({ tab }: { tab: BrowserTab }) {
  const [history, setHistory] = useState<string[]>([normalizeUrl(tab.url)])
  const [index, setIndex] = useState(0)
  const [addr, setAddr] = useState(tab.url)
  const [loading, setLoading] = useState(true)
  const [reloadNonce, setReloadNonce] = useState(0)

  const currentUrl = history[index]
  const canGoBack = index > 0
  const canGoForward = index < history.length - 1

  function navigateTo(raw: string) {
    const next = normalizeUrl(raw)
    setHistory((h) => [...h.slice(0, index + 1), next])
    setIndex((i) => i + 1)
    setAddr(next)
    setLoading(true)
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    navigateTo(addr)
  }

  function goBack() {
    if (!canGoBack) return
    const prevIndex = index - 1
    setIndex(prevIndex)
    setAddr(history[prevIndex])
    setLoading(true)
  }

  function goForward() {
    if (!canGoForward) return
    const nextIndex = index + 1
    setIndex(nextIndex)
    setAddr(history[nextIndex])
    setLoading(true)
  }

  function reload() {
    setReloadNonce((n) => n + 1)
    setLoading(true)
  }

  return (
    <div className="bpane">
      <div className="baddr">
        <span className="nav">
          <button
            type="button"
            className="nav-btn"
            onClick={goBack}
            disabled={!canGoBack}
            aria-label="Back"
          >
            ‹
          </button>
          <button
            type="button"
            className="nav-btn"
            onClick={goForward}
            disabled={!canGoForward}
            aria-label="Forward"
          >
            ›
          </button>
          <button type="button" className="nav-btn" onClick={reload} aria-label="Reload">
            ⟳
          </button>
        </span>
        <form className="url" onSubmit={handleSubmit}>
          <span className="lock">●</span>
          <input
            className="url-input"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            spellCheck={false}
          />
        </form>
        {loading ? <span className="bspinner" aria-label="Loading" /> : null}
      </div>
      <div className="bview dark">
        {/*
          allow-scripts + allow-same-origin is the known sandbox-escape pairing:
          a same-origin document can reach the embedder and neutralize the rest
          of the sandbox. We accept it deliberately — this is a browser tab whose
          whole job is to render arbitrary real sites, which need scripts, their
          own cookies and storage (same-origin) to function; dropping either flag
          turns most pages into broken shells. The mitigation is scope, not the
          attribute: the src is agent/user-supplied inside a locally-trusted Tauri
          webview with no privileged bridge exposed to the frame.
        */}
        <iframe
          key={`${index}:${reloadNonce}`}
          className="bframe"
          src={currentUrl}
          title={tab.title}
          onLoad={() => setLoading(false)}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
    </div>
  )
}
