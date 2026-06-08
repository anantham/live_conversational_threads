# LCT × IndrasNet — productizing the conversation→views pipeline

**Status:** proposal (2026-06-08) · **Owner ask:** stop the one-off `.tmp_*` scripts; make LCT consume IndrasNet's aggregated conversations and focus on *views*, while IndrasNet focuses on *aggregating comms across channels*. **Hard constraint:** no arbitrary compression — the full raw transcript must always be retainable and the graph auditable against it.

Grounded in a 5-agent code read of both repos. The big finding: **the production pipeline already largely exists in LCT** — the `.tmp_*` scripts were a parallel reimplementation. Productizing ≈ wiring proven logic into existing services + adding provenance/raw-retention + a versioned contract.

---

## 1. The boundary (who owns what)

**IndrasNet — aggregation + source of truth.** Ingests every channel (Beeper → Discord/Telegram/Slack/Matrix/WhatsApp/IG; Meet/audio transcripts), normalizes into `items` keyed by `group_id` (the conversation key); owns contact identity (`contacts`, `contact_identities`, `item_participants` diarization → `contact_id`); owns the privacy contract (three-gate `core/views/gates.py::check_gates`, redaction `share_pipeline.py`); mints the **stable conversation identity** LCT keys off. LCT must NOT re-aggregate channels, build its own contact directory, or re-diarize.

**LCT — sense-making views.** Given ONE conversation's raw turns, builds the 5-tier graph (`services/hierarchical_themes/level_*_clusterer.py` → `graph_persistence.py::persist_graph`), the rhetoric/argument layer (supports/rebuts/clarifies + crux/tangent/surprise/flags), the `.threads`/`.canvas` artifacts (`artifact_export_service.py`, `canvas_api.py`), the quality/coverage audit, and the local-only share surface (`share_api.py`, ADR-036). LCT **iterates on views, not aggregation.**

**Handoff (both loopback, no external egress):** IndrasNet → LCT pushes redacted raw turns for one `group_id` via `lct_client.import_transcript → POST /api/import/from-text` (returns `conversation_id`). LCT → IndrasNet is only a thin signal `POST /api/lct/prayers/detect` (signal text + small context window, **never** graph/transcript). Rule: *text + identity + privacy flags cross the seam; channel polling, contact dedup, gate enforcement stay in IndrasNet.*

---

## 2. Data contract (`RawTurn[]`, versioned)

Keyed by IndrasNet `group_id`; two access modes returning the **same shape**:
- **PUSH** (today's path — lossy, needs upgrade): IndrasNet `lct_client.py` posts `{text, conversation_name, owner_id}` to `import_from_text`, which is a **markdown import, NOT a `RawTurn[]` contract** — `/from-text` does **not** accept `conversation_id` (that param is on `/process-file`), and markdown can't carry per-turn identity, `contact_id`, timestamps, redaction status, or provenance. PUSH must be upgraded to a structured turns payload (new endpoint or extend `from-text`) with real `conversation_id` dedup. ⚠️ Today this path also ships the **unredacted** source — privacy bug, see §9.
- **PULL** (new, for re-extraction/backfill): `GET /api/lct/conversations/{group_id}/turns` on IndrasNet (generalize `core/db/items.py::get_nearby_messages_in_chat`) — gates+redaction run server-side; LCT never reads the DB file. (NOT `/api/retrieval/search` — that's cross-source rerank, wrong semantics.)

```
{ conversation_id, group_id, source_type, contract_version,
  privacy: { external_llm_ok, local_llm_ok, redaction_applied, redaction_map_id },
  turns: [ { seq, source_identifier, speaker_id, contact_id, text (verbatim, never truncated), ts_start, ts_end } ] }
```
Each `RawTurn` → one `Utterance` row (matches `serialize_utterances`, `conversation_reader.py:412`). **`(seq, source_identifier)` is the durable provenance key** carried to `node.source_ref`.

---

## 3. Raw retention & provenance (the "no compression" constraint)

Verbatim retained at **four levels**, every node linked back:
1. **IndrasNet source of truth** — `items.raw_content` (immutable, per-turn `source_identifier`); LCT can always re-pull.
2. **LCT mirror** — every turn → `Utterance.text` + `sequence_number` + **new `Utterance.source_identifier`** (lossless local copy, survives IndrasNet offline).
3. **Node→source provenance (the fix)** — **new `node.source_ref` = {utterance_ids, source_identifiers, start_seq, end_seq, coverage_pct}**, computed in `build_graph_data_from_nodes()`. `source_excerpt` is **demoted to a display snippet only** — never the provenance mechanism. Clustering/embedding **must** propagate `source_ref` through children (cluster range = union of child ranges) or set `is_leaf_drop=True`; a CI assertion fails the build if an emergent node has empty `source_ref` without that flag. → kills the "clustering drops the transcript" bug.
4. **Artifact** — `.threads` carries `full_transcript` (verbatim from `serialize_utterances`) + `transcript_source` ∈ {`verbatim` | `reconstructed` | `source_excerpts_only`}. If >5 MB, embed `transcript_url` (LCT-local/obscure) + `transcript_integrity_hash` instead of inlining. Removes the lossy `build_chunk_dict_from_utterances` fallback (`conversation_reader.py:393-402`). Legacy conversations stamp `source_excerpts_only` + `coverage_pct=null` so the viewer signals "unauditable" rather than faking coverage.

---

## 4. Pipeline stages (replace `.tmp_*`)

A real `lct_pipeline/` package — config-driven, idempotent, versioned. Each stage → its productized home + the `.tmp` it replaces:

| # | Stage | Home | Replaces |
|---|-------|------|----------|
| 0 | Ingest/pull raw turns | `lct_pipeline/ingest.py` (+ `indrasnet_turns_adapter`), reuses `import_api.py` | transcription/reassembly move back to IndrasNet |
| 1 | Privacy boundary (gate/redact) | `lct_pipeline/privacy.py` guard + egress chokepoint; redaction stays in IndrasNet | `.tmp_privacy_redact.py` (delegated) |
| 2 | Extract hierarchy | existing `level_*_clusterer.py` + `persist_graph` | `.tmp_extract_*`, `.tmp_remap_speakers` |
| 3 | Extract rhetoric + **auto adversarial-verify** | `lct_pipeline/rhetoric.py` → `Relationship` table | `.tmp_rhetoric_*`, `.tmp_bake_*` |
| 4 | Embed | `lct_pipeline/embed.py` (configurable dim, no hardcoded PCA-16) | `.tmp_embed_corpus.py` |
| 5 | Cluster (cross-conversation map) | `lct_pipeline/cluster.py` (+ `include_edges_out=True`) | `.tmp_hier_cluster.py` |
| 6 | Name | `lct_pipeline/name.py` | `.tmp_name_arc.py`, `.tmp_apply_names.py` |
| 7 | Combine corpus (contact-scoped) | `lct_pipeline/combine.py` + `contact_thread_index` | `.tmp_combine_corpus.py`, `.tmp_normalize_speakers.py` |
| 8 | Export artifact (+ `full_transcript` + `source_ref` + `coverage_pct`) | **`.threads` = `share_api.py`** (today emits only `graph_data`+`chunk_dict`); `conversation_reader.py` builds graph_data. (`artifact_export_service.py` is `.canvas`/`.txt`, NOT `.threads`.) | export half of `.tmp_combine_corpus.py` |
| 9 | Quality-check (coverage audit) | `lct_pipeline/quality.py` + viewer Coverage Report/Provenance panel | `.tmp_compare_extractions.py` |
| 10 | Serve/share (local-only) | existing `share_api.py` + static `ThreadsViewer` | `.tmp_corpus_server.py` |
| 11 | Speaker-ID | **moves to IndrasNet** `voice_profiles` (approval-gated) | `.tmp_enroll_*` (relocated) |

---

## 5. Quality checks (first-class, was manual)

- **Coverage %** = covered turn-text / total turn-text; per-speaker bars + gap list in the viewer.
- **Orphaned-utterance** detection (seq ranges with no covering node); export warns over threshold.
- **Per-node provenance validation** (CI `test_cluster_integrity.py`): every non-leaf-drop node has valid `source_ref`.
- **Dangling-edge count** after namespacing/clustering.
- **Rhetoric adversarial verification** as a gate (skeptic survival ratio; no asserted fallacy without verification).
- **Privacy leak scan** (forbidden-strings parity with IndrasNet) over the exported artifact AND any frontier-bound text — redact the spec too.
- **Round-trip fidelity** (`persist_graph(include_edges_out=True)` preserves edges + `source_ref`).
- **Transcript integrity** (sha256 in bundle; viewer verifies).

---

## 6. Privacy rules (carry forward)

- **Gate first, always** — three-gate (enabled / local_llm_ok / external_llm_ok, most-restrictive across participants) before any model call; LCT re-checks `external_llm_ok` before any frontier call.
- **`external_llm_ok` is opt-in (default 0)** — local models by default; frontier (codex/GPT-5, Opus naming) only when every participant opted in.
- **Redact before frontier** — IndrasNet's `share_pipeline` + canonical `REDACTION_MAP`; restore only on LCT-local display; redact the prompt too; reuse, don't rebuild.
- **`LCT_LOCAL_ONLY` egress chokepoint** at the network layer (wrap httpx/websockets/urllib, ADR-034) — not per-call guards; verify with codex-exec adversarial review.
- **LCT↔IndrasNet is loopback** (43181 ↔ 127.0.0.1:7777, not Tailscale-self); LCT→IndrasNet carries no conversation data.
- **Share is local-only + obscure-URL** (HttpOnly cookie, `allowed_emails`); no public CDN unless explicitly approved.

---

## 7. Roadmap (smallest valuable first)

- **P0 — Provenance + raw retention** *(no IndrasNet dependency).* `Utterance.source_identifier`; `node.source_ref` in `build_graph_data_from_nodes`; `build_full_transcript_for_export()` → `full_transcript` + `transcript_source` in the bundle; remove the lossy chunk_dict fallback; ship NodeDetail **Provenance** panel + ThreadsViewer **Coverage Report**. **This alone satisfies the audit-against-source constraint and needs nothing from IndrasNet.**
- **P1 — Data contract (one conversation).** `contract_version`'d `RawTurn`; `indrasnet_turns_adapter`; IndrasNet `GET /api/lct/conversations/{group_id}/turns`; pass stable `conversation_id` through `import_from_text` (dedup); `Conversation.indrasnet_group_id` FK. Any single conversation flows IndrasNet→LCT losslessly with provenance.
- **P2 — Kill `.tmp_*`.** `lct_pipeline/` package + `PipelineConfig` + idempotent `run_pipeline.py`; migrate stage-by-stage; CI lint rejecting new `.tmp_` scripts; `tests/` (privacy, cluster_integrity, rhetoric_verify, round_trip).
- **P3 — Contact generalization (ANY contact).** `contact_thread_index` (group_id↔contact_id); "all conversations with X" + contact-scoped combined export (aggregated cruxes/action-items/open-threads); cross-conversation clustering with `source_ref` propagation; delete LCT speaker-remap (consume `contact_id`).
- **P4 — Live + cross-meeting + hardening.** Live consume path (lull-sampling → `/api/lct/prayers/detect` → `/ws/transcripts`); first-class cross-meeting rhetoric edges; codex-exec chokepoint + leak harness in CI.

---

## 8. Open decisions (recommendations)

1. **PULL mechanism** → **new `GET /api/lct/conversations/{group_id}/turns`** (gates server-side; not direct DB read, not `/retrieval/search`).
2. **Default extraction model** → **local by default; frontier only when `external_llm_ok=1`** (don't promise frontier quality on the local path; deep argument analysis stays IndrasNet reprocessing).
3. **Redaction ownership** → **IndrasNet owns the canonical map**; LCT keeps only a local restore-on-display copy; delete `.tmp_privacy_redact`.
4. **Large transcript** → **inline if <5 MB else `transcript_url` + sha256**.
5. **Speaker-ID** → **moves to IndrasNet**; LCT consumes `contact_id` (kills the fuzzy speaker-remap).
6. **Cross-conversation rhetoric edges** → **P4, map-level rolled-up only**; deep cross-conversation reasoning = IndrasNet reprocessing.

---

## 9. Review & corrections (codex, 2026-06-08)

Independent read-only adversarial review (`codex exec`). **Verdict: P0 is directionally right, but the plan was NOT build-ready** — several "already wired" claims were false. These corrections are authoritative and supersede the optimistic phrasing above.

**Code-grounded fixes**
- `POST /api/import/from-text` accepts only `{text, conversation_name, owner_id}` — **no `conversation_id`** (that's on `/process-file`, `import_api.py:541`); IndrasNet `lct_client.py:104` posts only those three. → real dedup + a structured turns contract are **new** work, and `from-text` is a lossy markdown import (no turn identity/`contact_id`/timestamps/redaction/provenance).
- The `.threads` exporter is **`share_api.py`** (`:381/:430`, emits `graph_data`+`chunk_dict` only) — **not** `artifact_export_service.py` (that's `.canvas`/`.txt`). `full_transcript` must be added there. (`ThreadsViewer.jsx:205` already downloads `bundle.full_transcript` if present; backend just doesn't populate it.)
- **`Utterance.source_identifier` does not exist** (`core.py:82` has `sequence_number`, `chunk_id`, `node_id`, `platform_metadata`); **`Node.source_ref` does not exist** (`graph.py:15` has `utterance_ids` + `source_excerpt`). Node→utterance is a **plain array, not a FK** — provenance is computable only where `utterance_ids` are actually populated (legacy/live nodes may lack them).
- `build_graph_data_from_nodes` + `persist_graph` do **not** compute/persist `source_ref` today.
- Lossy fallback confirmed real: `conversation_reader.py:393` duplicates the full transcript under every chunk id when utterances lack `chunk_id`.

**Architecture corrections**
- **`source_ref` must be PERSISTED** (`Node.source_ref` JSONB, or a deterministic read-model over persisted `utterance_ids` + utterance source fields) with tests — not read-time-only (it drifts).
- **Raw vs redacted, by trust boundary** (resolves the "no compression" vs "redact before share" tension): raw source-of-truth stays in **IndrasNet**; the **LCT mirror is REDACTED** unless an explicit owner-local mode permits raw. "No arbitrary compression" = no lossy summarization of whatever tier LCT holds — it does **not** mean LCT must hold unredacted text.
- The `LCT_LOCAL_ONLY` chokepoint is real (`backend.py:126`, `egress_chokepoint.py:42`) but only blocks **network egress** — it does NOT enforce consent, redaction correctness, or handoff-text correctness (separate guarantees).

**🔴 Privacy bug — fix before relying on the handoff**
IndrasNet's `also_share_to_lct` imports `text=content` = the **original (unredacted)** stitched source (`privacy.py:865/:940`); the redacted `artifact_md` is built in `produce_share_artifacts()` but **not returned in `ShareResult`** (`share_pipeline.py:882/:1040`). Fix `produce_share_artifacts` to return the redacted artifact + `lct_client` to send THAT (or disable the path) before any privacy-sensitive use.

**Revised P0 (GO with preconditions; do NOT start P1/P2 until P0's provenance contract is tested):**
1. Define the exact **stored** provenance shape; Alembic migrations: `Utterance.source_identifier`, `Node.source_ref` (JSONB), `Conversation.indrasnet_group_id`.
2. Populate `source_identifier` on new imports; persist `source_ref` computed from **real** `utterance_ids`; legacy/live nodes lacking them → `coverage_pct=null`, `transcript_source='source_excerpts_only'` (viewer shows "unauditable", never fakes coverage).
3. Add `full_transcript` to the **`share_api.py`** `.threads` export; remove the `conversation_reader.py:393` chunk-duplication fallback.
4. Ship NodeDetail Provenance panel + ThreadsViewer Coverage Report.
5. Fix/disable the IndrasNet `also_share_to_lct` unredacted-import path.

**Top risks (ranked):** (1) privacy leak at the handoff; (2) false dedup assumption; (3) provenance incomputable for legacy/live nodes; (4) schema-migration blast radius (models / Alembic / serializers / importers / export / frontend); (5) `.threads` size blowup from chunk duplication until `full_transcript` lands; (6) raw/redacted ambiguity.
