# Browser: capture screenshots and selective content

**Screenshot only when you need pixels (a visual check, a VLM look). For data,
use text capture: it is cheaper and parseable.**

## Screenshots (pixels)

| Scope | How |
| --- | --- |
| Viewport | `browser_screenshot({format})` |
| Full page | `browser_screenshot({fullPage: true, path})` |
| One element | `browser_screenshot({selector})` clips to that element's box |
| Saved to a file | pass `path`: the image is written on the Bureau host and the result carries the path, not base64 |

Prefer `path` for full-page and large captures so the bytes do not bloat the
response. Target the container selector for a whole block, not just the `h1`.

## Video of a tab (recording)

Record what one of your own tabs shows over time, for a visual trace of a flow.

| Step | Tool |
| --- | --- |
| Start | `browser_record_start({tabId, fps?, format?})` returns `{ recordingId, tabId, instance, startedAt, source }` |
| Peek | `browser_record_frame({tabId})` returns the latest frame as an image plus `{ recordingId, index, t, frameCount }`; `frame: null` before the first one |
| Stop | `browser_record_stop({tabId, encode?})` returns `{ recordingId, path, frameCount, durationMs, status }` |

- `tabId` must be a tab you own (`browser_list_owned_tabs`). Another session's
  tab, or a tab Bureau did not open, answers `browser:not_owner`. A second
  start on the same tab answers `browser:recording_active`; a frame or stop
  with nothing running answers `browser:recording_not_found`.
- `source` is `screencast` on Chrome (CDP `Page.startScreencast`, a frame on
  each repaint) and `screenshot-poll` elsewhere (camofox). `fps` defaults to 3,
  clamped to [1, 10].
- Frames are written as they arrive, under the Bureau home in
  `recordings/<recordingId>/frames/f00000.jpg` with one `frames.jsonl` row
  each (`t`, `index`, `storagePath`). Stop encodes `video.mp4` with ffmpeg,
  each frame shown until the next one.
- `status` is `complete` (the path is the mp4), `frames-only` (ffmpeg missing
  or failed, or `encode: false`; the path is the folder, the frames are kept
  and `error` says to install ffmpeg) or `interrupted`: it stopped by itself
  because the tab closed, your session ended, Bureau stopped, or it reached 10
  minutes or 3000 frames (`reason` says which). The frames are kept then too.
- `GET /recordings?callerSessionId=` lists these recordings (`mode:
  "screencast"`) next to the per-action ones; they share their retention, and
  revoking the grant deletes them.

## Export a tab to a file (PDF, PNG, HTML, text)

`browser_export({tabId, format, selector?, fullPage?, landscape?, printBackground?, name?, instance?})`
renders one of your own tabs to a file on the Bureau host and returns
`{ path, format, mimeType, sizeBytes, sha256, tabId, instance, url, title }`.
The bytes never ride in the result. It writes a file, so it is a write tool.

| `format` | What you get | Chrome | camofox (Gecko) |
| --- | --- | --- | --- |
| `pdf` | the page printed (CDP `Page.printToPDF`; `landscape`, `printBackground` default true) | yes | refused: `browser:unsupported` |
| `png` | the viewport; `fullPage: true` for the whole page; `selector` for one element | yes | viewport and `selector` only; `fullPage` refused |
| `html` | the serialized DOM, or one element with `selector` | yes | yes |
| `text` | the readable text (`innerText`, like `scrape`), or one element with `selector` | yes | yes |

- `selector` is refused for `pdf`. `fullPage` is for `png` only and cannot be
  combined with `selector`. A selector that matches nothing answers
  `browser:export_failed`.
- `tabId` is required and must be a tab you own. Another session's tab answers
  `browser:not_owner`; an id that no longer exists, or that Bureau never
  opened, answers `browser:target_gone`.
- Files land in `<home>/exports/<time>-<id>[-<name>].<ext>`, readable by the
  Bureau user only, and are kept until you delete them. A render over 64 MiB is
  refused and nothing is written.
- There is no `html-zip` format (a page with its assets). For a single file
  use `html`; to save a served file use `browser_download`.

## Live video of a tab (watch it now)

`browser_live_view({tabId, instance?, fps?, quality?, maxWidth?, maxDurationSec?})`
shows one of your own Chrome tabs as live video in the `ui://bureau/live` view.
It returns the current frame as an image plus `{ streamId, tabId, expiresAt,
fps, visible, urls: { loopback, public?, replay?, replayPublic? } }`. Use it
when the user wants to watch; the video is kept when it ends. Use
`browser_record_*` when you need control over the file (start, frames, encode).

- `fps` 1-15 (default 8), `quality` 20-80 (default 50), `maxWidth` 480-1280
  (default 1280), `maxDurationSec` 30-600 (default 300).
- Chrome tabs only (CDP screencast). Another session's tab answers
  `browser:not_owner`; a tab being recorded answers `browser:live_busy`; a 4th
  stream in your session answers `browser:live_limit`. A new call on the same
  tab replaces its stream.
- `reuse: true` joins the tab's running stream instead of replacing it (same
  `streamId` and URLs, `reused: true`; the other arguments are ignored), and
  starts one when there is none (`reused: false`). Use it when a second viewer
  should watch the same live (your widget and the session chat): a plain
  second call replaces the stream, cutting the first viewer and splitting the
  kept video.
- The stream and replay URLs carry a secret token: do not paste them anywhere.
- It runs whether or not anyone watches, and stops at `maxDurationSec`, when
  the tab closes or your session ends. `browser_live_stop({streamId})` stops it
  now. A background tab sends no frames (`visible: false`).
- The frames it delivers are kept: when it ends, Bureau encodes
  `<home>/recordings/live-<streamId>/video.mp4` (ffmpeg) and deletes the frames.
  `browser_live_stop` waits for the encode and returns `video: { path,
  durationSec, frames, bytes }`, or `video: null` with `videoError` (ffmpeg
  missing or failed: the frames stay next to `meta.json`). `urls.replay` serves
  the mp4 once encoded (404 before). Kept videos older than
  `BUREAU_LIVE_KEEP_DAYS` (default 7) or beyond the newest
  `BUREAU_LIVE_KEEP_MAX` (default 30) are deleted.
- `browser_live_frame({streamId})` is for the view (latest frame, no new capture).

## Inline views (MCP Apps)

In a host that renders MCP Apps (Claude Desktop, ChatGPT, session chat), three
capture tools also show their result as a small inline view. Nothing changes
for any other client: the tool results are the same bytes, and the link is only
a `_meta.ui` entry on the tool in `tools/list`.

| Tool | View (`resources/read`) | Shows |
| --- | --- | --- |
| `browser_screenshot` | `ui://bureau/screenshot` | the image, with the tab id, instance and time; a `path` result shows the path as text |
| `browser_record_frame` | `ui://bureau/recording` | the latest frame, as "image n sur N" |
| `browser_record_stop` | `ui://bureau/recording` | status, frame count, duration and the path as text |

- The views are read-only: no button drives the browser, they call no tool
  (the links say `visibility: ["model"]`), and their CSP allows no network at
  all (`connect-src 'none'`). Each is one self-contained HTML file that follows
  the host's light or dark theme.
- The tab id and instance come from the tool input the host forwards; the time
  is when the result arrived.
- No video bytes are sent inline. The recording view shows the mp4 path and
  says "lecture bientôt": playback is not there yet.
- `browser_live_view` renders `ui://bureau/live`: an MJPEG image from Bureau's
  loopback stream listener (its CSP declares only that origin, and the public
  stream origin when configured), else a 1 s poll of `browser_live_frame`
  through the host, else the first frame. It pauses while hidden or scrolled
  out of view and has an "Arrêter" button. When the live ends it plays the kept
  video from `urls.replay` (its CSP adds `media-src` for the same origins),
  retrying every 2 s for up to 60 s while it is encoded.

## Selective content (text or structured), easiest first

| Want | Tool |
| --- | --- |
| "what is on this page" (clean text) | `browser_evaluate({expression})` returning `document.body.innerText` |
| "the text of THIS element" | `browser_evaluate({expression})` with `document.querySelector(sel).innerText` |
| raw markup, for finding a selector | `browser_get_dom({selector})`, or `path` for large pages |
| typed fields (author, date, price, counts) | `ld+json` (`script[type="application/ld+json"]`), or the site's internal API JSON |
| clean article as markdown | the site's HTML plus your own extraction, or a readability tool if the host exposes one |

`browser_evaluate` returns JSON-serialized values and supports async
expressions, so one call can run an in-page fetch and return its parsed JSON.

## Validated pattern (a news article)

One `browser_evaluate` call returned `{ title (h1), bodyPreview (selector
innerText), ld+json: author/datePublished/articleSection }`. `articleBody` was
empty when the page was paywalled, but the metadata and the free intro still
came through.

## When a write button has no clean API

Locate it with `browser_get_dom` (find the selector) and click that selector
with `browser_click`. Prefer the URL entry form when the action is a link (see
`writes.md`). Re-read the DOM before each click, because selectors and ids can
drift.
