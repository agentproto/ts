/**
 * @agentproto/social/ports — runtime ports injected by the host.
 *
 * The kit is pure: it never speaks to a platform, filesystem, or graph
 * directly. Hosts (social-cli for local topology, Guilde for cloud) supply
 * concrete implementations at construction time.
 */

export type {
  SocialSourcePort,
  CaptureOptions,
  SliceSupport,
} from "./social-source.port.js"
export type {
  GraphSinkPort,
  GraphOp,
  GraphPerson,
  GraphPost,
  GraphEngagement,
} from "./graph-sink.port.js"
export type {
  FootprintIndexPort,
  FootprintIndexRow,
  MediaIndexRow,
} from "./footprint-index.port.js"
export type { MediaArchivePort, StoredMedia } from "./media-archive.port.js"
