---
"@agentproto/runtime": patch
---

Telegram approval cards are sent as Telegram HTML (escaped, Markdown rendered instead of shown raw), announce every cut with the number of characters left out and a pointer to the approval page, and upload the files listed in `preview.attachments` as real documents or photos, resolved inside the data folder of the app that opened the approval. A path that leaves that folder, a missing file or one over Telegram's size limit is reported on the card.
