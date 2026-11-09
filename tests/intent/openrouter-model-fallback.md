# OpenRouter approved model fallback

Context: on 20 October 2026 Google retired the Vertex route for the single pinned map model. Transcription finished, and then every map request returned 404 until the model setting was changed by hand. The owner chose an approved fallback list over a moving "latest" alias. Cost, output format and recipient stay inside models someone has looked at.

- With `LCT_OPENROUTER_FALLBACK_MODELS` unset, the wire request, call count and responses are unchanged.
- The fallback list holds at most three valid model ids, with no duplicates and none equal to the primary. Any malformed list leaves generation unconfigured, with no upstream call and no reservation.
- Every attempt sends the same `provider.only` and `data_collection` as the primary; only `model` changes. Privacy rests on the per-request provider pin, not on OpenRouter's undocumented `models`-array behaviour.
- The next model is tried only on 404 or 503, where no provider accepted the request. 400/401/402/403/429/502 and any 200 response, valid or not, never trigger another model.
- One admitted generation stays one attempt row, whichever model serves it. The response names the model that served.
- Status reports the fallback list so the consent screen can name every model that may receive the transcript.
- The health check counts approved models with at least one endpoint on the configured provider. Zero routes makes the service "Needs attention" before any transcription. A listing that cannot be read counts as unknown, not missing.
- The Gemini (Google AI Studio) backend and the private replay path stay single-model.
