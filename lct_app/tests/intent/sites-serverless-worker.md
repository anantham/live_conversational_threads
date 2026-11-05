# Sites serverless Worker — test intent

- Exercise the Worker fetch interface with synthetic Requests and mocked OpenAI responses; never use a real key, recording, transcript, or paid inference.
- Preserve streamed chat, upstream errors, and realtime-token responses while enforcing methods, origins, API-key requirements, and the existing approximate per-isolate rate limits.
- Accept the exact Site origin without allowing unrelated Site origins; use Cloudflare's client IP rather than caller-supplied forwarding headers.
- Require a visitor's API key in this initial slice. An owner trial key must not enable anonymous spending on the Sites adapter.
- Report unsupported Python API routes explicitly, and delegate page/assets requests to the asset binding. This is infrastructure validation, not proof that live recording or meeting bots work without the Python backend.
- Build an ESM bundle exposing fetch(request, env, ctx), and smoke it without a Node process global or external network access.
