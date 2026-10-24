/**
 * `media-viewer` — a single-agent agentproto app for media cataloging.
 *
 * One agent (cataloger) scans a workspace folder for images, video, and audio
 * files, collects metadata, and produces a structured JSON catalog. Paired
 * with a Cowork McpApp gallery widget for visual browsing.
 */

import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { cataloger } from "./agents/cataloger.js"
import { scanMedia } from "./workflows/scan-media.js"
import { MEDIA_VIEWER_HTML, MEDIA_VIEWER_TOOLS } from "./ui.js"

export const mediaViewer: AppHandle = defineApp({
  id: "@agentproto/media-viewer",
  name: "Media Viewer",
  version: "0.1.0",
  description: "Scan a folder for images, video, and audio — gallery view.",
  agents: [cataloger],
  workflows: [scanMedia],
  ui: {
    html: MEDIA_VIEWER_HTML,
    title: "Media Viewer",
    tools: [...MEDIA_VIEWER_TOOLS],
  },
})

export { cataloger, scanMedia }
