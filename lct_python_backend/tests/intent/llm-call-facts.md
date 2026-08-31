# Test intent: durable facts-only LLM call telemetry

- Public async chat, sync chat, and embedding gateway calls persist one logical
  fact with the provider/model actually served and the requested capability.
- Fallback records the successful attempt position; total failure records a
  safe error code without prompt, response, exception body, or private reason.
- Missing provider usage remains null rather than being fabricated as zero.
- The schema has no price or content-bearing fields, and persistence failure
  never changes the model call's observable result.
