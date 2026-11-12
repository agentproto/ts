---
"@agentproto/reach": patch
"@agentproto/runtime": patch
---

One rule for an attachment's name (`attachmentNameOf`, exported from reach): a string, or an object's first non-empty `name`, `filename` or `fileName`. The REACH preview parser and the Telegram approval card now read the job kit's `{ filename, mimeType }` attachments, so the `Files:` line appears.
