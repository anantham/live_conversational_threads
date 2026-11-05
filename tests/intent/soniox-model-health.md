# Soniox model-listing health

- Through the public Worker health route, distinguish matching documented HTTP/status_code/error_type pairs for authentication and model-listing permission refusal.
- Keep transcription, billing and temporary-key permissions unverified; never turn a metadata result into successful STT or make a paid/session request.
- Bound error bodies, respect the existing deadline/cache, refuse malformed/inconsistent/unexpected metadata, and expose only fixed classification/copy (never message, request ID, key or body).
- Preserve capacity, attempt ledgers, configuration, other provider checks and disabled/exhausted refusal behavior using the existing isolated in-memory schema.
