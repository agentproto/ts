---
"@agentproto/app": minor
"@agentproto/runtime": minor
---

Every installed app with a UI can now be installed from the browser as a desktop app (Chrome "Install", Safari "Add to Dock"). The daemon builds a web app manifest from `APP.md` and serves it at `/apps/<id>/manifest.webmanifest`, serves the icons under `/apps/<id>/icons/<n>`, and adds the manifest, theme-color and apple-touch-icon tags to the page at `/apps/<id>/ui`. A page that already links its own manifest is left alone.

A new optional `ui.install` block in `APP.md` refines the result: `shortName`, `themeColor`, `backgroundColor`, `display` and `icons` (paths inside the app). Without it the name comes from the app, the icon from `store.icon` if set, otherwise a generated one with the app's initials. Icons are only served from inside the app folder and only if the file really is an image. Follows AIP-53 "Installable UI".
