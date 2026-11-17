# Browser: write actions (gated)

> **HARD RULE: every write acts AS THE USER and is attributable** (a message, a
> connection invite, a like, a comment, a post). Never send speculatively. Each
> send needs the user's explicit confirmation, for that action. Harnesses are
> draft-only by default; the actual send sits behind an explicit flag.

## Pattern

1. **Prefer URL entry over clicking a navigating link.** Many write entry
   points ARE links that open a prefilled composer (a message composer URL
   that takes the body as a query parameter, for example). Navigate to them
   directly.
2. **Draft, confirm, send.** Build the action (prefilled where possible),
   capture it with `browser_screenshot` or `browser_get_dom`, show the user,
   then click the Send or confirm control. Find its selector from a fresh DOM
   read; labels like "Envoyer", "Send" or "Envoyer une invitation" may be
   disabled until a required field is filled.
3. **Verify.** Re-read the page and observe the result: the thread shows your
   message, the composer cleared, and so on.

## Attach a file to a form

`browser_upload_file({selector, paths, tabId?, instance?})` points an
`<input type=file>` of one of your tabs at files on the Bureau host, for
example a CV on a job application. It is a write tool, gated like
`browser_fill`, and returns `{ selector, tabId, instance, files: [{ path, name,
sizeBytes }] }`, never the bytes.

- Chrome reads the file from disk itself (CDP `DOM.setFileInputFiles`) and
  fires `input` and `change`, so a page CSP that blocks other origins does not
  matter. Camofox (Gecko) answers `browser:unsupported`.
- `selector` must match an `<input type=file>`: a styled "Upload" button is not
  one, so read the DOM and target the (often hidden) input behind it. No match,
  or another element, answers `browser:upload_failed`.
- `paths` are absolute, at most 10, each an existing regular file of at most
  25 MiB (26214400 bytes) under an allowed root, after symlinks are resolved.
  Anything else answers `browser:upload_refused` and the page is not touched.
- Allowed roots: `<home>/exports` (so a `browser_export` file can be attached),
  `upload.roots` in `browsers.yaml`, and the colon-separated
  `BUREAU_UPLOAD_ROOTS`. Both lists take absolute or `~/` paths and are read
  when Bureau starts.
- `tabId` is a tab you own; omit it for your most recent one. Another session's
  tab answers `browser:not_owner`.
- Verify after: re-read the page for the file name the form shows, then submit
  only with the user's go.

## Rate and safety

- **Rate-limit and space writes like a human.** Bursts get flagged, and some
  sites flag much faster than others.
- Reads can be logged too; profile views are visible to the target.
- One sanctioned send at a time; confirm each; never batch-send without a
  per-item ok.
