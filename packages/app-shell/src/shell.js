import { KITS } from "./kit.js"

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export function navCount(count, counts) {
  if (count === undefined) return ""
  const value = typeof count === "number" ? count : counts?.[count]
  if (value === undefined || value === null) return ""
  return `<span class="count">${String(value).padStart(2, "0")}</span>`
}

export function renderShell(
  activeRoute,
  counts,
  {
    brand,
    logo,
    home = "",
    navItems = [],
    navLabel = "Main navigation",
    live = false,
    liveCaption = "",
    idleCaption = "",
  } = {}
) {
  if (typeof brand !== "string" || brand === "") {
    throw new TypeError("renderShell: options.brand is required")
  }
  if (typeof logo !== "string" || logo === "") {
    throw new TypeError("renderShell: options.logo is required")
  }
  const nav = navItems
    .map(item => {
      const active = item.route === activeRoute
      const href = item.route ? `#/${item.route}` : "#"
      const soon = item.route ? "" : ` data-soon="${escapeHtml(item.label)}"`
      return `<a href="${href}"${active ? ' class="active" aria-current="page"' : ""}${soon}>${escapeHtml(item.label)}${navCount(item.count, counts)}</a>`
    })
    .join("")

  return `<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="#/${escapeHtml(home)}"><span class="logo">${escapeHtml(logo)}</span><b>${escapeHtml(brand)}</b></a>
    <nav class="nav" aria-label="${escapeHtml(navLabel)}">${nav}</nav>
    <div class="side-foot">${escapeHtml(live ? liveCaption : idleCaption)}</div>
  </aside>
  <main class="main">
    <header class="topbar" id="topbar"></header>
    <div class="content" id="view"></div>
  </main>
</div>
<div id="demo-toast" class="toast" role="status" hidden></div>`
}

export function renderTopbar({
  title,
  badge = "",
  actor = "",
  actions = "",
  demoLabel = "",
  kitLabel = "Kit",
  kitAriaLabel = "Visual kit",
  kits = KITS,
}) {
  return `<div><h1>${escapeHtml(title)}</h1></div>
    <span class="spacer"></span>
    ${badge}
    ${actor ? `<div class="actor">${actor}</div>` : ""}
    ${actions}
    ${demoLabel ? `<span class="demo-label">${escapeHtml(demoLabel)}</span>` : ""}
    <label class="tiny muted">${escapeHtml(kitLabel)} <select class="kit-switch" aria-label="${escapeHtml(kitAriaLabel)}">${kits.map(kit => `<option value="${escapeHtml(kit.value)}">${escapeHtml(kit.label)}</option>`).join("")}</select></label>`
}
