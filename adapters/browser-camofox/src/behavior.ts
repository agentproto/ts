/**
 * Human-behavior pacing primitives for camofox - the single source of truth for
 * the timing that makes a session look human (jittered typing, settled clicks,
 * post-navigation reading pauses) and for recognizing an anti-bot wall. The
 * camofox CONTROL driver and the social capture session both pace from here, so
 * the two surfaces can't drift on what "human" means.
 *
 * Pure timing helpers - no I/O, no camofox client. A caller maps a
 * {@link BehaviorProfile} to a delay (or typing flags) and applies it with its
 * own transport. `fast` collapses every delay to zero (the raw opt-out).
 */

import type { BehaviorProfile } from "@agentproto/driver-browser"

/** Sleep helper shared by both pacing surfaces. */
export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * A jittered delay in [lo, hi). Uses wall-clock as the entropy source (cheap,
 * good enough to break a metronomic signature - this is anti-fingerprinting
 * timing, not security randomness).
 */
export const jitter = (lo: number, hi: number): number =>
  lo + Math.floor(Date.now() % Math.max(1, hi - lo))

/**
 * Post-navigation reading dwell. A human doesn't act the instant a page loads;
 * `fast` skips the pause, `stealth` lingers a touch longer than `human`.
 */
export function navDwellMs(profile: BehaviorProfile): number {
  if (profile === "fast") return 0
  return profile === "stealth" ? jitter(800, 2200) : jitter(500, 1600)
}

/**
 * Settle pause after a click/press. Anti-bot heuristics flag back-to-back
 * actions ("rapid taps"), so a human-paced action never fires into the next.
 */
export function actionSettleMs(profile: BehaviorProfile): number {
  if (profile === "fast") return 0
  return profile === "stealth" ? jitter(900, 2200) : jitter(700, 1800)
}

/**
 * Typing options for the camofox `/type` endpoint. `human: true` makes the
 * service type keystroke-by-keystroke with `delay` ms of jitter between keys;
 * `fast` sets the field value in one shot (the bot-shaped instant fill).
 */
export function typingOptions(profile: BehaviorProfile): {
  human: boolean
  delay: number
} {
  if (profile === "fast") return { human: false, delay: 0 }
  return { human: true, delay: profile === "stealth" ? 120 : 90 }
}

/**
 * In-page expression (an IIFE returning a boolean) that recognizes an anti-bot
 * wall - a DataDome / captcha-delivery challenge iframe, or a "verification
 * required / enable JS" interstitial - instead of silently reading an empty page
 * and reporting zero results. Shared so the control driver's `stealth` check and
 * the social session's `isBlocked` use one detector.
 */
export const BLOCKED_PAGE_EXPRESSION = `(() => {
  try {
    // datadome serves the challenge from *.captcha-delivery.com (iframe or script).
    if ([...document.querySelectorAll("iframe,script")].some(f => /captcha-delivery\\.com|datadome|geo\\.captcha/i.test(f.src || ""))) return true;
    const body = document.body ? document.body.innerText : "";
    const text = ((document.title || "") + " " + body).slice(0, 4000);
    // The "enable JS / disable ad blocker" interstitial is a near-empty page
    // whose message lives in <noscript>/inline markup, not innerText - so on
    // a SMALL page also scan the raw HTML. Real result pages are large and
    // never carry these phrases, so we skip the (costly) HTML scan there.
    const small = body.length < 1500;
    const html = small && document.documentElement ? document.documentElement.innerHTML.slice(0, 8000) : "";
    const hay = (text + " " + html).toLowerCase();
    return /verification required|are you human|verify you are human|unusual activity|détection de robot|please enable (js|javascript) and disable any ad|enable javascript and disable any ad|access to this page has been denied|blocked by datadome/.test(hay);
  } catch { return false }
})()`
