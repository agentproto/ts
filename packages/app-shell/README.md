# @agentproto/app-shell

A framework-free shell for agent apps: design tokens, component styles, kit
persistence and the sidebar/topbar markup. Plain ESM and CSS, no runtime
dependency, no build step. It works from a single-file HTML build (inline the
CSS, import the ESM) and from a React or Vite app (React renders its own markup
against the same class vocabulary).

```sh
pnpm add @agentproto/app-shell
```

## What is in the box

| Export | What |
| --- | --- |
| `@agentproto/app-shell/tokens.css` | `--color-*`, typography, spacing, radii and elevation variables, plus the built-in kits |
| `@agentproto/app-shell/components.css` | shell, panels, badges, buttons, tables, widgets and responsive rules, written against the tokens |
| `@agentproto/app-shell` | `KITS`, `applyKit`, `initialKit`, `renderShell`, `renderTopbar`, `navCount`, `escapeHtml`, with types |

```css
@import "@agentproto/app-shell/tokens.css";
@import "@agentproto/app-shell/components.css";
```

## Rendering the shell

`brand` and `logo` are required. Every user-facing label is a parameter with a
neutral English default, so a localised app passes its own strings.

```js
import { applyKit, initialKit, renderShell, renderTopbar } from "@agentproto/app-shell"

const STORAGE_KEY = "my-app.kit" // required: namespace it per app

document.body.innerHTML = renderShell("inbox", { inbox: 3 }, {
  brand: "Acme Desk",
  logo: "AD",
  home: "inbox",
  navItems: [
    { route: "inbox", label: "Inbox", count: "inbox" },
    { label: "Reports" }, // no route: rendered as a "soon" placeholder
  ],
  navLabel: "Main navigation",
  live: true,
  liveCaption: "Local data, read only",
})

document.getElementById("topbar").innerHTML = renderTopbar({
  title: "Inbox",
  demoLabel: "", // text of the optional demo chip; omitted when empty
  kitLabel: "Kit",
  kitAriaLabel: "Visual kit",
})

applyKit(initialKit(location.search, STORAGE_KEY), STORAGE_KEY)
```

| Option | Default |
| --- | --- |
| `renderShell` `brand`, `logo` | required, throws when missing |
| `renderShell` `home` | `""` (the brand links to `#/`) |
| `renderShell` `navLabel` | `"Main navigation"` |
| `renderShell` `liveCaption` / `idleCaption` | `""` / `""` (sidebar footer when `live` is true / false) |
| `renderTopbar` `demoLabel` | `""` (chip omitted) |
| `renderTopbar` `kitLabel` / `kitAriaLabel` | `"Kit"` / `"Visual kit"` |
| `renderTopbar` `kits` | the built-in `KITS` |

`applyKit(value, storageKey)` and `initialKit(search, storageKey)` take the
storage key explicitly; there is no default, so two apps on one origin never
share a preference. `initialKit` reads `?kit=<name>&mode=<light|dark>` first,
then the stored value, then `prefers-color-scheme`.

## Built-in kits

A kit value is `<kit>-<mode>`. Two kits ship. Their public names are neutral;
the stylesheet keeps its original `data-kit` attribute values so existing
selectors do not change.

| `KITS` value | Label | `data-kit` attribute | Radii (sm/md/lg) |
| --- | --- | --- | --- |
| `paper-light` | Paper light | `workshop` | 4 / 8 / 14 px |
| `paper-dark` | Paper dark | `workshop` (`data-mode="dark"`) | 4 / 8 / 14 px |
| `graphite-light` | Graphite light | `forge` (`data-mode="light"`) | 3 / 6 / 10 px |
| `graphite-dark` | Graphite dark | `forge` | 3 / 6 / 10 px |

`paper` is a warm light palette, `graphite` a cool dark one. `applyKit` maps
the public name to the attribute (`paper-dark` sets `data-kit="workshop"`
`data-mode="dark"`). In your own CSS, target the attribute values.

## Adding an app's own kit

1. Define the palette and radii under a new `data-kit` value, after the
   `tokens.css` import. Override only what differs; the components follow the
   variables.

   ```css
   :root[data-kit="acme"] {
     --rounded-sm: 2px; --rounded-md: 4px; --rounded-lg: 8px;
     --color-background: #fbfbff; --color-surface: #ffffff;
     --color-ink: #1b1b2f; --color-ink-muted: #5c5c7a;
     --color-accent: #3a3af0; --color-accent-fg: #ffffff;
   }
   :root[data-kit="acme"][data-mode="dark"] {
     --color-background: #12121f; --color-surface: #1b1b2f;
     --color-ink: #f2f2ff; --color-ink-muted: #a3a3c2;
     --color-accent: #8c8cff; --color-accent-fg: #12121f;
   }
   ```

2. Pass the options to the switcher. A name that is not built in is used as the
   `data-kit` value unchanged, so `acme-dark` sets `data-kit="acme"`
   `data-mode="dark"`.

   ```js
   const MY_KITS = [
     { value: "acme-light", label: "Acme light" },
     { value: "acme-dark", label: "Acme dark" },
   ]
   renderTopbar({ title: "Inbox", kits: MY_KITS })
   applyKit("acme-dark", STORAGE_KEY)
   ```

## Stylesheet contract

`components.css` owns the shell, panels, badges, buttons, tables, widgets and
responsive rules. App-specific classes (documents, queues, decisions, demo
chat) belong in the app's own stylesheet. Selector order is part of the
contract: generic rules come first so an app's rules cascade over them.
