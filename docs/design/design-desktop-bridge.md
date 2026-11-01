# Desktop bridge design note

Today nothing can wake a Desktop turn: external rows have no process, so events park in the inbox and are pulled by hooks. The simplest bridge: daemon calls the app's send_message to deliver a prompt that starts a turn, needing session id + message text.
