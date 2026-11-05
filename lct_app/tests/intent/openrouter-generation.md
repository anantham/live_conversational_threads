# OpenRouter recording generation — test intent

- Build a pure bounded non-streaming strict-schema request from finalized source, an explicit provider/model ID and caller-supplied output token limit. The request contains only normalized utterance IDs/text and the truthful completion flag; it contains no recording ID, speaker/timing/media/account fields or credential.
- Treat exact utterance text as untrusted evidence, ignore embedded instructions or tool requests, and return an isolated schema so a caller cannot alter future requests.
- Require structured-output provider support and disable automatic provider fallback. No default model, key, fetch, storage, retry, publication, or paid request is part of this slice.
- Accept only a successful complete assistant JSON response. Reject provider/choice errors, refusals, length/content-filter/tool results, malformed/oversized JSON, and graph references that contradict the exact source.
- Round-trip synthetic generated output through the existing v2 .threads reader and Discussion consumer, preserving all authored tiers and original utterance evidence without altering inputs.
