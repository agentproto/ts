// useShortcuts — window-level keyboard shortcuts for the desktop shell.
// ⌘K/Ctrl+K opens the command palette, ⌘F focuses the rail's filter input,
// ⌘1/⌘2/⌘3 switch tabs (transcript / files / the first browser tab, if any).
// Standalone: callers wire the handlers to whatever state they own (App.tsx).

import { useEffect, useRef } from "react"

export interface ShortcutHandlers {
  onPalette: () => void
  onFocusFilter: () => void
  onSwitchTab: (tabId: string) => void
}

const TAB_FOR_DIGIT: Record<string, "transcript" | "files"> = {
  "1": "transcript",
  "2": "files",
}

export function useShortcuts(handlers: ShortcutHandlers): void {
  // Keep the latest handlers in a ref so the keydown listener subscribes once
  // (empty deps) instead of re-binding on every render — callers pass a fresh
  // object literal each render, which would otherwise churn the listener.
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      const key = e.key.toLowerCase()

      if (key === "k") {
        e.preventDefault()
        ref.current.onPalette()
        return
      }

      if (key === "f") {
        e.preventDefault()
        ref.current.onFocusFilter()
        return
      }

      if (key === "1" || key === "2") {
        e.preventDefault()
        ref.current.onSwitchTab(TAB_FOR_DIGIT[key])
        return
      }

      if (key === "3") {
        e.preventDefault()
        ref.current.onSwitchTab("browser")
        return
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
