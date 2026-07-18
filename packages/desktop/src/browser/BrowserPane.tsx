// Browser view for one agent browser tab: an address bar + a placeholder panel
// noting the live browser session. Deep/live page embedding is explicitly OUT
// of scope (SPEC WP3) — we render the address bar + a "browser session" note
// rather than pulling a heavy webview into the app.

import type { BrowserTab } from "../data/types"

export function BrowserPane({ tab }: { tab: BrowserTab }) {
  return (
    <div className="bpane">
      <div className="baddr">
        <span className="nav">‹ › ⟳</span>
        <span className="url">
          <span className="lock">●</span>
          {tab.url}
        </span>
        <button className="btn ghost xs">Open devtools</button>
      </div>
      <div className="bview dark">
        <div className="bpreview">
          <div className="frame">
            <div className="fbar">
              <i />
              <i />
              <i />
            </div>
            <div className="fbody">
              <div className="bp-title">◇ browser session</div>
              <div className="bp-url">{tab.url}</div>
              <div className="bp-note">
                Live page embedding is out of scope for this shell — the agent
                drives this session; its address is shown above.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
