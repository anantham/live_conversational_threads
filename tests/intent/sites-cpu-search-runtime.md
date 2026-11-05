# CPU-only search runtime and asset limit

- Both browser builds select the paired CPU/WASM loader and binary; worker messages still rank synthetic conversation passages using the pinned MiniLM model and q8 configuration.
- Actual WASM inference must produce finite normalized embeddings and rank the intended semantic passage without requesting a GPU/Asyncify runtime; mocks alone cannot establish compatibility.
- The Sites build rejects any regular client asset larger than 25 MiB, accepts the exact boundary, and rejects symbolic links before packaging.
- Missing/unavailable runtime assets surface a search error; cancellation and worker failures retain the existing text-search fallback and request identity.
- Same Site, schema, data, secrets and generation flags remain unchanged; the published asset and factory bytes must match the validated local build.
