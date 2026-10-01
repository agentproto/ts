// Mobile keyboard visibility for the composer. iOS/Android overlay keyboards
// (interactive-widget=resizes-visual, the default) leave window.innerHeight at
// its full height while the visual viewport shrinks, so a composer laid out at
// the bottom of the layout viewport ends up UNDER the keyboard. The fix:
//
//  (a) track window.visualViewport (resize + scroll) and write the overlap
//      (innerHeight - vv.height - vv.offsetTop) into the `--kb-inset` CSS var
//      on the document root; shell.css lifts the composer by that amount with
//      a margin-bottom (plus env(safe-area-inset-bottom) padding).
//  (b) reveal the focused textarea via scrollIntoView({ block: "end" }) on
//      focusin and again on every viewport resize while it stays focused.
//  (c) flip the viewport meta to interactive-widget=resizes-content when the
//      app runs in a browser tab, so the layout viewport shrinks with the
//      keyboard and the overlap drops to 0 (original meta restored on cleanup).
//
// Everything no-ops on desktop: no visualViewport → no listeners; and even
// with one present (Tauri's WebView exposes it), overlap is 0 without a soft
// keyboard, so --kb-inset is always "0px" and the CSS falls back to the old
// layout. Guarded + cleanup'd; SSR (no window) safe. The injectable env is
// exported so the listener wiring is testable in a plain Node test env.

import { useEffect } from "react"

const INSET_VAR = "--kb-inset"

/** Editable elements that trigger the soft keyboard on mobile. */
function isEditable(el: EventTarget | null): boolean {
  const tag = (el as HTMLElement | null)?.tagName
  return tag === "TEXTAREA" || tag === "INPUT"
}

/** How many CSS px of the layout viewport the keyboard covers but the visual
 * viewport (richer: accounts for pinch-zoom offsetTop) does not. */
export function computeKeyboardOverlap(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
): number {
  return Math.max(0, innerHeight - vvHeight - vvOffsetTop)
}

export interface KeyboardViewportVisualViewport {
  height: number
  offsetTop: number
  addEventListener(
    type: "resize" | "scroll",
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void
  removeEventListener(
    type: "resize" | "scroll",
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void
}

export interface KeyboardViewportWindow {
  addEventListener(
    type: "focusin" | "focusout",
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void
  removeEventListener(
    type: "focusin" | "focusout",
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void
}

export interface KeyboardViewportEnv {
  visualViewport: KeyboardViewportVisualViewport | null
  getWindow(): KeyboardViewportWindow
  getInnerHeight(): number
  getRootStyle(): { setProperty(name: string, value: string): void }
  /** Restore the `interactive-widget` viewport meta on cleanup (or null when
   * there is none / the host browser is not a mobile tab). */
  updateViewportMeta?(): { restore(): void } | null
}

/**
 * Attach the keyboard-tracking listeners, write `--kb-inset` on the root
 * style, and reveal the focused editable. Returns a full cleanup.
 */
export function attachKeyboardViewport(env: KeyboardViewportEnv): () => void {
  const vv = env.visualViewport
  if (!vv) return () => undefined

  const root = env.getRootStyle()
  const overlapNow = () =>
    computeKeyboardOverlap(env.getInnerHeight(), vv.height, vv.offsetTop)

  const applyInset = () => {
    const overlap = overlapNow()
    root.setProperty(INSET_VAR, overlap > 0 ? `${Math.round(overlap)}px` : "0px")
    return overlap
  }

  let focused: HTMLElement | null = null
  let blurTimer: ReturnType<typeof setTimeout> | undefined

  const reveal = (el: HTMLElement | null) => {
    // Older engines may not implement scrollIntoView with options — degrade
    // silently instead of throwing (the inset lift already fixes the case).
    try {
      el?.scrollIntoView?.({ block: "end" })
    } catch {
      /* ignore */
    }
  }

  const onViewportChange = () => {
    applyInset()
    if (focused) reveal(focused)
  }

  const onFocusIn = (e: Event) => {
    if (!isEditable(e.target)) return
    focused = e.target as HTMLElement
    reveal(focused)
  }

  const onFocusOut = (e: Event) => {
    if (e.target !== focused) return
    focused = null
    // The keyboard usually collapses a beat after blur; give the viewport a
    // moment (older iOS fires no resize at all — recheck then clear anyway).
    clearTimeout(blurTimer)
    blurTimer = setTimeout(applyInset, 150)
  }

  vv.addEventListener("resize", onViewportChange)
  vv.addEventListener("scroll", onViewportChange)
  const win = env.getWindow()
  win.addEventListener("focusin", onFocusIn, true)
  win.addEventListener("focusout", onFocusOut, true)

  const meta = env.updateViewportMeta?.()

  return () => {
    vv.removeEventListener("resize", onViewportChange)
    vv.removeEventListener("scroll", onViewportChange)
    win.removeEventListener("focusin", onFocusIn, true)
    win.removeEventListener("focusout", onFocusOut, true)
    clearTimeout(blurTimer)
    root.setProperty(INSET_VAR, "0px")
    meta?.restore()
  }
}

/** Ensure the browser tab uses `interactive-widget=resizes-content` so the
 * layout viewport (and window.innerHeight) shrinks with the keyboard and the
 * overlap math converges to 0. Reads/updates only — restores on cleanup. */
export function ensureInteractiveWidgetMeta(doc: Document): {
  restore(): void
} | null {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  const original = meta?.getAttribute("content") ?? null
  const withFlag = (content: string) =>
    content.includes("interactive-widget")
      ? content
      : `${content}, interactive-widget=resizes-content`

  if (meta && original && !original.includes("interactive-widget")) {
    meta.setAttribute("content", withFlag(original))
  } else if (!meta) {
    const created = doc.createElement("meta")
    created.setAttribute("name", "viewport")
    created.setAttribute("content", "width=device-width, initial-scale=1, interactive-widget=resizes-content")
    doc.head?.appendChild(created)
    return {
      restore() {
        created.remove()
      },
    }
  }
  return {
    restore() {
      if (meta && original !== null) meta.setAttribute("content", original)
    },
  }
}

export function useKeyboardViewport(): void {
  useEffect(() => {
    if (typeof window === "undefined") return undefined
    const w = window as typeof window & { visualViewport?: VisualViewport | null }
    const doc = document
    return attachKeyboardViewport({
      visualViewport: (w.visualViewport as KeyboardViewportVisualViewport) ?? null,
      getWindow: () => w,
      getInnerHeight: () => w.innerHeight,
      getRootStyle: () => doc.documentElement.style,
      updateViewportMeta: () => ensureInteractiveWidgetMeta(doc),
    })
  }, [])
}

export default useKeyboardViewport
