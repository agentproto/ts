// The center tab strip: a Transcript tab plus one tab per agent browser
// session. Active tab is owned by App ("transcript" | <browser-tab-id>).

import type { BrowserTab } from "../data/types"

// Fixed tab ids plus one per open browser tab (see browserTabsFor).
export type ActiveTab = "transcript" | "files" | string

interface TabStripProps {
  tabs: readonly BrowserTab[]
  activeTab: string
  onSelect: (tab: string) => void
}

export function TabStrip({ tabs, activeTab, onSelect }: TabStripProps) {
  return (
    <div className="tabs">
      <div
        className={`tab${activeTab === "transcript" ? " active" : ""}`}
        onClick={() => onSelect("transcript")}
      >
        <span className="ico">◇</span>
        <span className="lbl">Transcript</span>
      </div>
      <div
        className={`tab${activeTab === "files" ? " active" : ""}`}
        onClick={() => onSelect("files")}
      >
        <span className="ico">🗂</span>
        <span className="lbl">Files</span>
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${activeTab === tab.id ? " active" : ""}`}
          onClick={() => onSelect(tab.id)}
          title={tab.url}
        >
          <span className="ico">🌐</span>
          <span className="lbl">{tab.title}</span>
          <span className="x">×</span>
        </div>
      ))}
      <div className="tab newtab" title="Open a page">
        ＋
      </div>
    </div>
  )
}
