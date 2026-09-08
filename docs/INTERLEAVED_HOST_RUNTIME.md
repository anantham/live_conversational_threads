# Host runtime configuration

Status: implemented startup and HTTP/WS handoff, **not deployed**. Bulk source-first
ingestion and async diarization integration remain separate required work.

The host may set `LCT_INTERLEAVED_RUNTIME_CONFIG` to a local JSON file. With no
path, startup leaves the interleaved runtime disabled. A configured but invalid
file aborts startup instead of falling back to a different processing policy.
This is host configuration, never a request field or a consent grant.

The currently supported native counter is the measured Qwen/Ollama protocol:
`qwen3.8:27b-mlx`, Ollama `0.33.3`, non-thinking, tokenizer engine
`tokenizers==0.23.0rc0`. The engine must already exist. Nothing installs it.
Its current approval is for the isolated replay environment, not an instruction
to install it in the production environment. Before activation, verify actual
server version, model/tokenizer identity, rendering parity and serving capacity.
A matching configured model label alone does not establish that evidence.

Example shape (replace IDs/path with validated host values):

```json
{
  "version": "qwen_ollama_0333_v1",
  "context_limits": {"verified-local-provider-id": 32768},
  "embedding_provider_ids": ["verified-local-provider-id"],
  "tokenizer_path": "/absolute/path/to/verified/tokenizer.json",
  "budgets": {
    "output_tokens": 8192,
    "headroom_tokens": 512,
    "passage_target_tokens": 4096,
    "embedding_input_tokens": 8192,
    "embedding_batch_tokens": 32768
  },
  "temperature": 0
}
```

Unknown keys are rejected, including privacy/provider credentials. IDs resolve
against existing server-owned provider settings. Context capacities are explicit
deployment values, not inferred capabilities. Selected routes must be private;
chat routes must match the counter protocol and embedding routes name a model.
Tokenizer bytes must match the measured SHA256 pinned in `host_bootstrap.py`.

Startup captures non-secret provider contracts. A later change to selected model,
revision, protocol, endpoint, trust scope, reasoning or embedding model rejects
before new stage construction; it requires host revalidation/restart rather than
silently keeping the old counter. Conversation ownership, retention policy and
stored consent are checked independently by the journal/stages.

Activation changes the behavior of structured extraction and live sessions.
Validate fresh, restart, revoked-consent and legacy-graph cases on a disposable
database before a production activation. Disabling this setting does **not**
make legacy graph replacement safe: journal-backed conversations remain protected
by the journal write guard. Retain configuration to resume those conversations.
