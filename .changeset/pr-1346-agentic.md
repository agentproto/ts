---
"@agentproto/corpus-cli": patch
---

STT pipeline improvements: add `engine` and `speakerLabelsLocalToSegment` to `Transcript`, suffix speaker labels by segment in `ChunkedStt`, advance chunk offsets by each part's real span, and tolerate explicit null utterance timestamps in the AssemblyAI adapter.
