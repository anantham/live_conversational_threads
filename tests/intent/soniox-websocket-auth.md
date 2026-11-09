# Test Intent: Soniox browser WebSocket authentication

- The public `connect` call passes the temporary key as the second WebSocket protocol entry and sends a start configuration without `api_key`.
- A provider authentication refusal after `open` reaches the failure callback with a sanitized error, closes the socket, and does not retry automatically.
- Cancellation before `open` prevents a late start message; an explicit retry uses only its new key and remains usable.
- Existing bounded audio, finish, timeout, and transcript behavior remains intact.
