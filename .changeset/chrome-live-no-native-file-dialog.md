---
"@agentproto/adapter-browser-chrome": patch
---

chrome-live agent tabs no longer open the native OS file chooser: the driver turns on `Page.setInterceptFileChooserDialog` at bootstrap, so an agent that clicks an "Upload" button before `uploadFileOwnedTarget` no longer leaves a macOS dialog open on the user's screen. The upload itself (`DOM.setFileInputFiles` on the input element) is unchanged.
