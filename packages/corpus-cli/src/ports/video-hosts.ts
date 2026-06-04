/**
 * Shared video-host detection. Video URLs belong to the transcription
 * fetcher (yt-dlp → STT); the readability fetchers MUST refuse them, so a
 * failed transcription is skipped-and-retried rather than silently
 * falling through to scrape a JS-rendered watch page (which yields the
 * page chrome — "About Press Copyright…" — not the talk).
 */

export const VIDEO_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "vimeo.com",
])

export function isVideoUrl(
  url: string,
  extraHosts?: ReadonlySet<string>
): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  const bare = host.replace(/^www\./, "")
  return (
    VIDEO_HOSTS.has(host) ||
    VIDEO_HOSTS.has(bare) ||
    (extraHosts?.has(host) ?? false) ||
    (extraHosts?.has(bare) ?? false)
  )
}
