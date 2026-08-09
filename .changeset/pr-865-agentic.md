---
"agentproto-vscode": minor
---

Dim the route chip when only one gateway is valid, preventing no-op clicks. Adds `isRouteSwitchable()` utility function (reuses `resolveRouteRows` for consistency) and UI-computed `routeSwitchable` flag to `SessionDescriptor`. The controller caches the model catalog and stamps the flag before posting session updates, allowing the composer's route chip to settle into its dimmed/active state. Backward compatible (routeSwitchable is optional); catalog fetch is defensive fire-and-forget.
