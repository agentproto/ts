/**
 * A few DOM helpers for the pair pages: no framework, no inline styles or
 * `innerHTML` (the page runs under `style-src 'self'` / `script-src 'self'`).
 * Every view is rebuilt and swapped in whole; the pages are small.
 */

export type Child = Node | string | null | undefined | false

interface Props {
  class?: string
  href?: string
  type?: string
  disabled?: boolean
  onClick?: () => void
}

export function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.href !== undefined) el.setAttribute("href", props.href)
  if (props.type !== undefined) el.setAttribute("type", props.type)
  if (props.disabled) el.setAttribute("disabled", "")
  if (props.onClick) el.addEventListener("click", props.onClick)
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === "string" ? document.createTextNode(child) : child)
  }
  return el
}

export function render(root: HTMLElement, view: Node): void {
  root.replaceChildren(view)
}

export type Tone = "neutral" | "ok" | "warn" | "danger"

let previewBanner: string | null = null

/** Label every view on a preview host (set once at boot by src/main.ts). */
export function setPreviewBanner(text: string | null): void {
  previewBanner = text
}

export function shell(opts: { eyebrow: string; title: string; tone?: Tone }, ...children: Child[]): HTMLElement {
  return h(
    "div",
    { class: "page" },
    previewBanner ? h("p", { class: "preview-banner" }, previewBanner) : null,
    h(
      "section",
      { class: "card" },
      h("div", { class: "eyebrow" }, h("span", { class: `dot dot-${opts.tone ?? "neutral"}` }), opts.eyebrow),
      h("h1", {}, opts.title),
      h("div", { class: "body" }, ...children),
    ),
  )
}

export function p(...children: Child[]): HTMLElement {
  return h("p", {}, ...children)
}

export function code(text: string): HTMLElement {
  return h("code", {}, text)
}

/** A fingerprint in groups of 4 (easier to compare with the terminal). The
 *  gaps are CSS margins, so copying it yields the raw hex. */
export function fingerprint(value: string): HTMLElement {
  const groups = value.match(/.{1,4}/g) ?? [value]
  return h("code", { class: "fingerprint" }, ...groups.map(g => h("span", {}, g)))
}

export function button(
  label: string,
  onClick: () => void,
  opts: { variant?: "primary" | "secondary" | "danger"; disabled?: boolean } = {},
): HTMLElement {
  return h(
    "button",
    { type: "button", class: `btn btn-${opts.variant ?? "primary"}`, onClick, disabled: opts.disabled },
    label,
  )
}

export function linkButton(label: string, href: string): HTMLElement {
  return h("a", { class: "btn btn-primary", href }, label)
}

export function row(...children: Child[]): HTMLElement {
  return h("div", { class: "row" }, ...children)
}

export function command(text: string): HTMLElement {
  return h("code", { class: "command" }, h("span", { class: "prompt" }, "$ "), text)
}

/** Where to get a QR: shown whenever there is nothing (usable) to open. */
export function howToPair(): HTMLElement[] {
  return [
    p("On the computer running the agentproto daemon:"),
    command("agentproto pair offer --qr"),
    p(
      "Scan the QR code with this phone's camera. The pairing link opens this daemon's own page, and you confirm its fingerprint against the one printed in the terminal.",
    ),
  ]
}

export function errorText(message: string): HTMLElement {
  return h("p", { class: "error-text" }, message)
}
