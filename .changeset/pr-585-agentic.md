---
"@agentproto/runtime": patch
---

Add Linux bubblewrap (`bwrap`) sandbox backend for the `command_execute` sandbox, implementing phase 3 of the command-sandbox work. The new `buildBwrapArgs()` function constructs bubblewrap confinement arguments using an allowlist-by-construction pattern: only bound paths are visible, system dirs are read-only, the workspace is read-write, and strict mode isolates the network namespace. `resolveCommandSandbox()` now returns the bwrap backend when bubblewrap is installed on Linux, falling back to null elsewhere. Includes comprehensive unit and end-to-end tests with platform-specific skips.
