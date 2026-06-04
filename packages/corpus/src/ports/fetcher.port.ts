/**
 * FetcherPort — the "URL → readable text" boundary the WebImporter
 * consumes. Keeps the importer PURE and testable: the importer decides
 * *what* to import (slugging, dedup, candidate shape); the port supplies
 * the one capability that is environment-bound — fetching and reducing a
 * URL to text.
 *
 * Structural interface, NOT nominal — any object of this shape satisfies
 * it. Concrete implementations live where the capability lives:
 *
 *   - `plugin-local-browser` (agentproto daemon / PTY): tier-1 YouTube
 *     captions via InnerTube + tier-2 article readability, using the
 *     user's authenticated browser. This is the rich path.
 *   - a server-side headless fetcher (Guilde corpus-host): public
 *     captions + readability only, no user session.
 *   - a fake (tests): canned { title, text } per URL.
 *
 * The port is deliberately strategy-agnostic. A tier-3 Whisper impl
 * (yt-dlp → ffmpeg → STT) is just a fatter `fetch()` for caption-less
 * videos — the importer never changes.
 */

export type FetchedSourceKind = "video" | "article" | "page" | "unknown"

export interface FetchedSource {
  /** Human-readable title (video/page title or article headline). */
  readonly title: string
  /** Extracted text — a transcript for video, readable body for articles. */
  readonly text: string
  /** What the fetcher determined the URL to be. */
  readonly kind: FetchedSourceKind
  /** BCP-47 language code, when the fetcher can detect it. */
  readonly language?: string
  /** How the text was obtained — for provenance / dedup auditing. */
  readonly via?: "captions" | "readability" | "transcription" | string
}

export interface FetcherPort {
  /**
   * Fetch a URL and reduce it to text. Resolves with the extracted
   * source, or `null` when the URL cannot be reduced to text (e.g. a
   * caption-less video on a tier that does not transcribe). Returning
   * `null` lets the importer skip-with-warning rather than abort the
   * batch; throwing is reserved for hard failures (auth, network).
   */
  fetch(url: string): Promise<FetchedSource | null>
}
