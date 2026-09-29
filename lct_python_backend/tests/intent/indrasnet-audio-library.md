# IndraSNet audio library integration test intent

- The owner can browse searchable audio metadata from IndraSNet without transferring transcript text in list responses.
- Typed source keys prevent item/media ID collisions and reject malformed paths before a sibling-service call.
- A ready source imports through the existing RawTurnsPayloadV1 persistence contract; pending sources remain processable and extraction stays a separate visible stage.
- Disabled, unavailable, and malformed sibling responses fail clearly without exposing raw turns.
- Private catalog routes require the owner bearer even when global middleware is not installed; unknown or legacy sibling states have contextual recovery.
