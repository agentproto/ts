// Table-driven tests for the mobile keyboard-viewport wiring. Built on the
// injectable attachKeyboardViewport env (the hook injects browser globals),
// so these run in plain Node — no happy-dom needed. EventTarget/Event are
// Node globals; FocusEvent is not, so focus events are Events with the
// target patched via defineProperty (mirrors what real focusin/focusout do).

import { describe, expect, it, vi } from "vitest"

import {
  attachKeyboardViewport,
  computeKeyboardOverlap,
  type KeyboardViewportEnv,
  type KeyboardViewportVisualViewport,
} from "./useKeyboardViewport"

interface FakeField {
  tagName: string
  scrollIntoView: ReturnType<typeof vi.fn>
}

interface HarnessOptions {
  hasVv?: boolean
  vvHeight?: number
  vvOffsetTop?: number
  innerHeight?: number
}

interface Harness {
  env: KeyboardViewportEnv
  vv: (EventTarget & KeyboardViewportVisualViewport) | null
  win: EventTarget
  styleProps: Map<string, string>
  field: FakeField
}

type EventOrigin = EventTarget | { tagName: string }

function dispatch(
  target: EventTarget,
  type: string,
  eventTarget?: EventOrigin | null,
) {
  const event = new Event(type)
  if (eventTarget) {
    Object.defineProperty(event, "target", { value: eventTarget, configurable: true })
  }
  target.dispatchEvent(event)
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const {
    hasVv = true,
    vvHeight = 800,
    vvOffsetTop = 0,
    innerHeight = 800,
  } = options

  const styleProps = new Map<string, string>()

  const vv: Harness["vv"] = hasVv
    ? Object.assign(new EventTarget(), {
        height: vvHeight,
        offsetTop: vvOffsetTop,
      })
    : null

  const win = new EventTarget()

  const field: FakeField = {
    tagName: "TEXTAREA",
    scrollIntoView: vi.fn(),
  }

  const env: KeyboardViewportEnv = {
    visualViewport: vv,
    getWindow: () => win as never,
    getInnerHeight: () => innerHeight,
    getRootStyle: () => ({
      setProperty(name: string, value: string) {
        styleProps.set(name, value)
      },
    }),
  }

  return { env, vv, win, styleProps, field }
}

describe(computeKeyboardOverlap.name, () => {
  it.each([
    { label: "closed keyboard", innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, expected: 0 },
    { label: "ios overlay keyboard", innerHeight: 800, vvHeight: 370, vvOffsetTop: 0, expected: 430 },
    {
      label: "visual viewport scrolled down",
      innerHeight: 800,
      vvHeight: 370,
      vvOffsetTop: 40,
      expected: 390,
    },
    {
      label: "pinch-zoom (vv smaller but page scrolled)",
      innerHeight: 800,
      vvHeight: 300,
      vvOffsetTop: 500,
      expected: 0,
    },
  ])("$label → $expected px", ({ innerHeight, vvHeight, vvOffsetTop, expected }) => {
    expect(computeKeyboardOverlap(innerHeight, vvHeight, vvOffsetTop)).toBe(expected)
  })
})

describe("keyboard-offset-follows-visual-viewport", () => {
  it.each([
    { label: "keyboard absent", innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, expected: "0px" },
    {
      label: "keyboard open",
      innerHeight: 800,
      vvHeight: 370,
      vvOffsetTop: 0,
      expected: "430px",
    },
    {
      label: "keyboard open + vv scrolled",
      innerHeight: 800,
      vvHeight: 370,
      vvOffsetTop: 40,
      expected: "390px",
    },
  ])("resize ($label) writes --kb-inset $expected", ({ innerHeight, vvHeight, vvOffsetTop, expected }) => {
    const h = makeHarness({ innerHeight, vvHeight, vvOffsetTop })
    const cleanup = attachKeyboardViewport(h.env)
    dispatch(h.vv!, "resize")
    expect(h.styleProps.get("--kb-inset")).toBe(expected)
    cleanup()
  })

  it("tracks successive viewport changes (open → shift → close)", () => {
    const h = makeHarness({ innerHeight: 800, vvHeight: 800 })
    const cleanup = attachKeyboardViewport(h.env)

    h.vv!.height = 370
    dispatch(h.vv!, "resize")
    expect(h.styleProps.get("--kb-inset")).toBe("430px")

    h.vv!.offsetTop = 40
    dispatch(h.vv!, "scroll")
    expect(h.styleProps.get("--kb-inset")).toBe("390px")

    h.vv!.offsetTop = 0
    h.vv!.height = 800
    dispatch(h.vv!, "resize")
    expect(h.styleProps.get("--kb-inset")).toBe("0px")

    cleanup()
  })
})

describe("keyboard-offset-clears-on-blur", () => {
  it("clears the inset when the keyboard closes after blur", () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({ innerHeight: 800, vvHeight: 800 })
      const cleanup = attachKeyboardViewport(h.env)

      h.vv!.height = 370
      dispatch(h.vv!, "resize")
      dispatch(h.win, "focusin", h.field)
      expect(h.styleProps.get("--kb-inset")).toBe("430px")

      // Keyboard collapses right after blur: focusout then a viewport resize.
      dispatch(h.win, "focusout", h.field)
      h.vv!.height = 800
      dispatch(h.vv!, "resize")
      expect(h.styleProps.get("--kb-inset")).toBe("0px")

      // The deferred recheck after blur must not resurrect the inset.
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(150)
      expect(h.styleProps.get("--kb-inset")).toBe("0px")

      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it("rechecks on its own when no resize fires within the blur grace", () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({ innerHeight: 800, vvHeight: 370 })
      const cleanup = attachKeyboardViewport(h.env)
      dispatch(h.win, "focusin", h.field)

      // Older iOS fires no viewport resize on collapse — only the blur.
      dispatch(h.win, "focusout", h.field)
      h.vv!.height = 800
      vi.advanceTimersByTime(150)
      expect(h.styleProps.get("--kb-inset")).toBe("0px")

      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("scroll-into-view-on-focus", () => {
  it("reveals the focused field with block:end on focusin", () => {
    const h = makeHarness()
    const cleanup = attachKeyboardViewport(h.env)

    dispatch(h.win, "focusin", h.field)
    expect(h.field.scrollIntoView).toHaveBeenCalledWith({ block: "end" })

    cleanup()
  })

  it("re-reveals the still-focused field on viewport change", () => {
    const h = makeHarness()
    const cleanup = attachKeyboardViewport(h.env)

    dispatch(h.win, "focusin", h.field)
    dispatch(h.vv!, "resize")
    expect(h.field.scrollIntoView).toHaveBeenCalledTimes(2)

    cleanup()
  })

  it("ignores focus on non-editable targets and focusout of others", () => {
    const h = makeHarness()
    const cleanup = attachKeyboardViewport(h.env)

    const button = { tagName: "BUTTON", scrollIntoView: vi.fn() }
    dispatch(h.win, "focusin", button)
    expect(button.scrollIntoView).not.toHaveBeenCalled()

    dispatch(h.win, "focusout", button)
    dispatch(h.vv!, "resize")
    expect(button.scrollIntoView).not.toHaveBeenCalled()

    cleanup()
  })
})

describe("no-op-without-visual-viewport", () => {
  it("leaves the inset untouched and tolerates focus events + cleanup", () => {
    const h = makeHarness({ hasVv: false })
    const cleanup = attachKeyboardViewport(h.env)
    expect(cleanup).toBeTypeOf("function")

    dispatch(h.win, "focusin", h.field)
    expect(h.field.scrollIntoView).not.toHaveBeenCalled()
    expect(h.styleProps.get("--kb-inset")).toBeUndefined()
    expect(h.styleProps.size).toBe(0)

    expect(() => cleanup()).not.toThrow()
  })

  it("does not throw when the focused field has no scrollIntoView", () => {
    const h = makeHarness()
    const cleanup = attachKeyboardViewport(h.env)
    const fieldless = { tagName: "TEXTAREA" }

    expect(() => dispatch(h.win, "focusin", fieldless)).not.toThrow()
    expect(() => dispatch(h.vv!, "resize")).not.toThrow()

    cleanup()
  })
})

describe("cleanup", () => {
  it("detaches listeners and resets the inset to 0px", () => {
    const h = makeHarness({ innerHeight: 800, vvHeight: 370 })
    const cleanup = attachKeyboardViewport(h.env)

    dispatch(h.vv!, "resize")
    expect(h.styleProps.get("--kb-inset")).toBe("430px")

    cleanup()
    expect(h.styleProps.get("--kb-inset")).toBe("0px")

    // Listeners are gone: further events after cleanup must not re-apply.
    h.styleProps.set("--kb-inset", "sentinel")
    dispatch(h.vv!, "resize")
    dispatch(h.win, "focusin", h.field)
    expect(h.styleProps.get("--kb-inset")).toBe("sentinel")
  })
})
