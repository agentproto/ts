import { defineWorkflow } from "@agentproto/workflow"

export const scanMedia = defineWorkflow({
  id: "scan-media",
  name: "Scan Media",
  description:
    "Scan a folder for media files, collect metadata, and produce a structured catalog.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "catalog",
      kind: "agent",
      agent: { ref: "@agentproto/media-cataloger" },
      prompt:
        "Scan the workspace root folder for media files (images, video, audio). " +
        "Walk all subdirectories recursively. For each media file, collect its path, " +
        "name, type, extension, size, and modification date. Output the full catalog " +
        "as a single JSON object.",
    },
  ],
})
