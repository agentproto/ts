---
"@agentproto/cli": patch
---

Fix `agentproto app serve` injecting the bridge `<script>` inside a single-file app bundle's inlined JS when that JS contains the literal text `</head>` in a string, breaking the served page. `injectBridge` now anchors on the opening `<head>`/`<body>`/`<html>` tag instead of the first `</head>` match, matching the daemon's own `injectAfterStructuralTag` strategy.
