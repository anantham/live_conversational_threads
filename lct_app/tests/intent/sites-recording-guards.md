# Hosted recording guards

- Reject a repeated Start during microphone setup or active capture. Verify a single track, recorder and provider connection remain owned and Cancel shuts them down.
- A paused conversation continues through Resume. A second Start leaves the paused segment and duration budget intact.
- Cancelling before any audio, transcript or map exists permits in-app navigation and browser unload. A stopped conversation containing unsaved audio or transcript still blocks both when the user declines the warning.
