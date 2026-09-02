import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/apps v0.1.0
 * Ready-made agentproto apps (teams of agents + workflows) built on app-kit.
 */`,
  entry: {
    index: "src/index.ts",
    "code-team": "src/code-team/index.ts",
    "content-team": "src/content-team/index.ts",
    "mail-triage": "src/mail-triage/index.ts",
    "media-viewer": "src/media-viewer/index.ts",
    "ops-panel": "src/ops-panel/index.ts",
    "session-viewer": "src/session-viewer/index.ts",
    "sessions-panel": "src/sessions-panel/index.ts",
    "agents-overview": "src/agents-overview/index.ts",
    "bureau-sessions": "src/bureau-sessions/index.ts",
    "session-story": "src/session-story/index.ts",
    "live-session": "src/live-session/index.ts",
    "bin/sync": "src/bin/sync.ts",
  },
  format: ["esm"],
  splitting: false,
  // dts emitted by `tsc -p tsconfig.build.json` instead — @mastra/core's own
  // .d.ts (pulled transitively via app-kit) has generic-variance issues that
  // break rollup-plugin-dts even when external (same trick app-kit/mastra use).
  dts: false,
  external: [
    "@agentproto/app-kit",
    "@agentproto/agent",
    "@agentproto/workflow",
    "@agentproto/mastra",
    "@mastra/core",
    "@mastra/core/agent",
    "zod",
  ],
  noExternal: [],
})
