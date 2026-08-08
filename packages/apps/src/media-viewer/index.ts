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

export const mediaViewer: AppHandle = defineApp({
  agents: [cataloger],
  workflows: [scanMedia],
})

export { cataloger, scanMedia }
