---
"agentproto-vscode": minor
---

Add Configuration Lab webview panel for pre-spawn configuration preview. New features include:

- `harnessCapabilities(adapter?)` daemon API method for fetching harness capabilities
- New types: `HarnessCapabilities`, `HarnessProviderCapability`, `HarnessModelDiscovery`, `HarnessApplicationContract`, `ConfigurationLabSnapshot`, `ConfigurationLabAxisOptions`, `ConfigurationLabIssue`, `ConfigurationLabEffectiveField`, `ConfigurationLabSelectionInput`, `ConfigurationLabRawData`
- New `agentproto.configurationLab` webview view with Configuration Lab UI
- New `agentproto.openConfigurationLab` command to open the Configuration Lab
- New activity bar container `agentprotoConfig` ("Agentproto Lab")

The Configuration Lab lets users preview and configure harness, model, route, auth profile, posture, and effort settings before spawning an agent session, with validation feedback and effective configuration display.
