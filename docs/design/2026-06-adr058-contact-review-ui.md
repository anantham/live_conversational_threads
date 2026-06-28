# Design: ADR-058 §2 — Contact-Identity Curation Review UI (merge / split / confirm)

**Date:** 2026-06-29
**Status:** Draft (research + design only — no code committed)
**Scope:** ADR-058 §2 "Contact-identity curation (task #14)" — the review surface that lets a human gate auto-formed IndrasNet contacts.
**Audit basis:** read-only audit of `TemporalCoordination/grimoire/IndrasNet` at HEAD on 2026-06-29.

> **Repo-contention note.** Almost every "EXISTS" and "NEW" item below lives in the **TemporalCoordination (TC) / IndrasNet** repo, which has 3+ live agents working in it right now. This doc is research + design only. The build-plan section flags exactly which steps touch the contended repo so they can be sequenced when it's safe. The LCT repo is touched only by the consumer-side surfacing (see §2.2).

---

## 0. Terminology (introduced before use)

- **Contact** — a row in IndrasNet's `contacts` table; the canonical "person" record. Has a `contact_id` (e.g. `c_abc123`), `display_name`, `privacy_tier`, consent flags, `aliases[]`, linked `identities[]`, and a `confirmed` flag.
- **Identity** — a `contact_identities` row: a `(platform, external_id)` handle (e.g. `signal:+1555…`, `email:x@y.com`) linked to a contact. A contact can own many identities.
- **Pending identity** — a `pending_identities` row: a discovered handle **not yet linked** to any contact. This is the inbox of un-promoted handles.
- **`confirmed`** — the `contacts.confirmed` integer flag (0/1). `1` = the owner approved this as a real person (feeds redaction names, cross-conversation aggregation, external send). `0` = inert candidate. This is the human gate ADR-058 centers on.
- **Merge** — fold N source contacts into one survivor; sources are deleted, their identities/items/photos/aliases move to the survivor.
- **Split** — the inverse: take one contact that is actually two people and peel some identities/clusters off into a new contact. **No first-class "split" primitive exists** (see §1.4).
- **indrajala** — the name ADR-058 §1 used for "the IndrasNet frontend." **There is no `indrajala` directory.** The IndrasNet React frontend is `grimoire/IndrasNet/indras-ui/` (package name `indras-ui`). All UI citations below are in `indras-ui`.

---

## 1. Current state (what exists today, cited to file:line)

### 1.1 Backend — the contacts route package

All endpoints live under prefix `/api/contacts` (router defined `agents/routes/contacts/__init__.py:25`). The package was split out of a monolith in the "B6" sweep; submodules register `@router`-decorated endpoints (`__init__.py:55-61`). Every endpoint below is **already shipped**.

**CRUD + merge — `agents/routes/contacts/_crud.py`**

| Endpoint | What it does | file:line |
|---|---|---|
| `GET /api/contacts` | List contacts (paginated; `sort`, `search` substring). Returns `_serialize_contact` rows. **No `confirmed`/`reviewed` filter param.** | `_crud.py:35` |
| `GET /api/contacts/pending` | List `pending_identities` (un-promoted handles); 60s TTL cache | `_crud.py:76` |
| `POST /api/contacts/pending/{pending_id}/dismiss` | Dismiss a pending identity | `_crud.py:99` |
| `POST /api/contacts` | Create a contact (optionally with an identity / email / phone) | `_crud.py:114` |
| `POST /api/contacts/merge` | **Merge.** Body `{target_contact_id, source_contact_ids[], confirm:true}`. Server-side destructive-confirm gate (`confirm:true` required, else 400 — `_crud.py:194`). 409 on `MergeConflictError`. | `_crud.py:175` |

**Detail + confirm + update — `agents/routes/contacts/_detail.py`**

| Endpoint | What it does | file:line |
|---|---|---|
| `GET /api/contacts/{contact_id}/pending-discussions` | Read the contact's "Pending discussions" from their Obsidian note (consumed by LCT live surface) | `_detail.py:29` |
| `GET /api/contacts/{contact_id}` | Single contact + recent activity | `_detail.py:114` |
| `POST /api/contacts/{contact_id}/confirm` | **The human gate.** Body `{confirmed: bool}` (required, else 400). Writes `contacts.confirmed`. | `_detail.py:133` |
| `POST /api/contacts/{contact_id}` | Update display_name / tier / notes / consent flags / link email-phone | `_detail.py:178` |
| `GET /api/contacts/{contact_id}/temporal-corpus` | Items in time-windows around the contact's events (an attribution/merge surface) | `_detail.py:258` |
| `GET /api/contacts/{contact_id}/chats` | Chat sources matching the contact's name/aliases | `_detail.py:286` |

**Resolution / evidence — `agents/routes/contacts/_resolution.py`**

| Endpoint | What it does | file:line |
|---|---|---|
| `POST /api/contacts/link-identity` | Link a `(platform, external_id)` to a contact | `_resolution.py:30` |
| `POST /api/contacts/resolve` | Resolve free text → best-matching contact + score | `_resolution.py:53` |
| `POST /api/contacts/detect-channel` | Pick output channel for a recipient | `_resolution.py:72` |
| `GET /api/contacts/resolve-evidence` | **Person-first evidence aggregator.** For a query, returns display-names, pending identities, email mentions, suspicious self-labels, with sample items. Powers the Resolve-Person merge flow. Read-only. | `_resolution.py:101` |
| `POST /api/contacts/create-from-evidence` | Atomic: create contact + link identities + aliases + dismiss pendings + backfill + optional norm extraction | `_resolution.py:369` |
| `POST /api/contacts/backfill-participants` | Backfill `item_participants.contact_id` | `_resolution.py:518` |

**Attribution (face/voice clusters) — `agents/routes/contacts/_attribution.py`**

| Endpoint | What it does | file:line |
|---|---|---|
| `GET /api/contacts/{contact_id}/voice-candidates` | Voice segments auto-matched (suggested) to this contact but not confirmed | `_attribution.py:25` |
| `POST /api/contacts/{contact_id}/voice-candidates/claim` | Confirm voice candidates → assign segments, rebuild profile | `_attribution.py:44` |
| `POST /api/contacts/{contact_id}/voice-candidates/unclaim` | Reverse a voice claim (→ back to "suggested") | `_attribution.py:67` |
| `GET /api/contacts/{contact_id}/attribute/preview` | Face/voice clusters present in an item + current bindings | `_attribution.py:90` |
| `POST /api/contacts/{contact_id}/attribute` | Attribute items to a contact, optionally cascading face/voice clusters; 409 on cluster conflict | `_attribution.py:113` |

**Aliases / identities / linked-clusters — `agents/routes/contacts/_aliases_identities.py`**

| Endpoint | What it does | file:line |
|---|---|---|
| `GET /api/contacts/{contact_id}/linked-clusters` | Face/voice clusters linked to this contact | `_aliases_identities.py:28` |
| `POST /api/contacts/{contact_id}/unlink-cluster` | **Unbind** a face/voice cluster from a contact (keeps existing `item_participants` rows). The closest thing to a "split" primitive. | `_aliases_identities.py:40` |
| `POST /api/contacts/{contact_id}/aliases` | Add an alias | `_aliases_identities.py:68` |
| `DELETE /api/contacts/{contact_id}/aliases` | Remove an alias | `_aliases_identities.py:84` |
| `POST /api/contacts/{contact_id}/identities` | Attach an identity | `_aliases_identities.py:100` |
| `DELETE /api/contacts/{contact_id}/identities` | **Remove an identity from a contact** (orphans the handle; does NOT re-home it) | `_aliases_identities.py:118` |
| `PATCH /api/contacts/{contact_id}/identities/ingestion` | Toggle per-identity ingestion | `_aliases_identities.py:135` |

**Privacy norm editor — `agents/routes/contacts/_norm_editor.py`** (`GET`/`PUT`/`POST …/norms[/preview]`, `_norm_editor.py:153/196/245`) and **signed policy — `_privacy_policy.py:120`** (`GET …/privacy-policy`). These are LCT's privacy-gate inputs; not central to merge/split/confirm but part of the same panel.

### 1.2 Backend — the merge engine (well-hardened)

`merge_contacts(target, [sources])` lives in `core/db/contacts/_merge.py:43`. It is mature and codex-hardened (PR #61):

- Atomic `BEGIN IMMEDIATE` transaction; rolls back on any failure (`_merge.py:88, 286`).
- **Most-restrictive consent wins** on merge (`local_llm_ok`/`external_llm_ok` take `min` — `_merge.py:145-146`), most-private tier wins, notes concatenated, `privacy_norms` survivor-keeps-or-adopts-first (`_merge.py:150-170`).
- **Generic re-attribution**: introspects the live schema and re-points every `contact_id` / `*_contact_id` column from sources to survivor (`_merge.py:212-230`), so new tables are covered automatically.
- **`MergeConflictError`** (`_merge.py:18`): fails closed when a per-contact UNIQUE value (e.g. `voice_profiles`, `speaker_correction_patterns`, `contact_obsidian_links`) can't be auto-combined — caller must reconcile first (surfaced as HTTP 409 at `_crud.py:206`).
- Re-derives biometric chips for the survivor afterward (`_merge.py:289`).

**There is no `split_contact` / `unmerge` function anywhere** (verified: no split primitive in `core/db/contacts/`). The only decomposition primitives are `remove_contact_identity` (`_aliases_identities.py:118`) and `unlink_cluster_from_contact` (`_aliases_identities.py:40`) — both *detach* without re-homing to a new contact.

### 1.3 Backend — the `confirmed` gate already exists end-to-end

- Column: `contacts.confirmed INTEGER DEFAULT 0`, added by migration `core/db/schema.py:990` (the base DDL at `schema.py:279-287` does NOT include it — it is an ADR-009 additive column).
- Serialized on every contact: `_serialize_contact` emits `"confirmed": int(...)` at `_helpers.py:129`.
- Write endpoint: `POST /{id}/confirm` (`_detail.py:133`), with a strict "confirmed is required, no silent confirm" guard (`_detail.py:147`).

So ADR-058 §2's stated "surface a `confirmed` field on the contacts list endpoint" is **already done** — `confirmed` rides on both the list and detail payloads today.

### 1.4 Frontend — `indras-ui` (the real "indrajala")

The contacts UI is a React/Vite/Tailwind/TypeScript app under `indras-ui/src/contacts/`. It is mounted as the **Contacts page** (`indras-ui/src/ContactsPage.tsx`), shown when `activeView === 'contacts'` (`indras-ui/src/App.tsx:790`). The page composes:

- **`ContactListPanel.tsx`** — left column list. **Already renders the `confirmed` ✓** (green check, `ContactListPanel.tsx:147-149`). Sort dropdown (recent/interactions/updated/name). **No "needs review" filter, no review-queue mode.**
- **`ContactDetailPanel.tsx`** (57 KB) — right column detail. Contains:
  - A **confirm/unconfirm control** ("Approve this person" / "Unconfirm") calling `setContactConfirmed` (`ContactDetailPanel.tsx:276-320`).
  - Alias add/remove, identity attach/remove, consent-flag edit, norm editor.
  - **`VoiceCandidatesSection`** — claim/unclaim voice fingerprints (`ContactDetailPanel.tsx:106, 871`).
  - **`<MergePanel>`** mounted at the bottom (`ContactDetailPanel.tsx:1119`).
- **`MergePanel.tsx`** — **a complete merge surface.** Suggests likely-duplicate candidates (`rankMergeCandidates`), previews the survivor (`previewMerge`), shows a destructive-confirm dialog, calls `mergeContacts` (`MergePanel.tsx:214`). Mounts *inside* the selected contact's detail panel ("merge these other records INTO this contact").
- **`mergeSuggestions.ts`** — pure client-side duplicate heuristics (shared identity = 0.9, same name = 0.5, alias match, etc. — `mergeSuggestions.ts:73-146`) with a unit test (`mergeSuggestions.test.ts`). This is exactly the `aditya/Aditya`, `Vishnu GT ×2` detector ADR-058 wants — it just only runs **relative to one selected contact**, not as a global duplicate sweep.
- **`PendingIdentitiesPanel.tsx`** — the un-promoted handle inbox (link / dismiss / create-from-pending).
- **`ResolvePersonPanel.tsx`** (39 KB) — person-first evidence → merge flow driven by `resolve-evidence`.
- **`contactApi.ts`** — typed client for all of the above incl. `mergeContacts` (`contactApi.ts:127`), `setContactConfirmed` (`contactApi.ts:148`), alias/identity CRUD, norms.
- Face/voice cluster panels, validation panel.

**There is a separate `indras-ui/src/review/UnifiedReviewPanel.tsx`**, but it is a **media-extraction** review queue (transcription/handwriting/receipt/face_detection — `UnifiedReviewPanel.tsx:15, 53`), shown under `activeView === 'reviews'` (`App.tsx:811`). It is **not** a contact review queue and shares no code with contacts. The name "review" is already taken by this surface.

---

## 2. Gap analysis

### 2.1 What's already covered (do NOT rebuild)

| Capability | Status | Where |
|---|---|---|
| Merge two duplicate contacts (UI + backend + confirm dialog + conflict handling) | **DONE** | `MergePanel.tsx`, `_crud.py:175`, `_merge.py:43` |
| Duplicate detection heuristic (`aditya`/`Aditya`, `Vishnu GT`×2) | **DONE (per-contact)** | `mergeSuggestions.ts:73` |
| Confirm / reject (the human gate) — backend + a per-contact toggle | **DONE** | `_detail.py:133`, `ContactDetailPanel.tsx:276` |
| `confirmed` surfaced on list + detail payloads | **DONE** | `_helpers.py:129`, `ContactListPanel.tsx:147` |
| Alias add/remove (UI + backend) | **DONE** | `_aliases_identities.py:68/84`, `contactApi.ts` |
| Identity attach/remove, pending-identity inbox | **DONE** | `_aliases_identities.py`, `PendingIdentitiesPanel.tsx` |
| Detach a face/voice cluster or an identity from a contact | **DONE (detach only)** | `unlink-cluster` `_aliases_identities.py:40`, `remove-identity` `_aliases_identities.py:118` |

### 2.2 The single biggest gap

**There is no review *queue*** — no way to ask "show me the auto-formed contacts that still need a human decision," and no workflow that walks the owner through them. Everything today is **contact-at-a-time, pull-based**: you must already know a name, search for it, select it, and only *then* see its merge candidates and confirm toggle. ADR-058's intent ("let a human gate the final confirmation," batch-curate the false positives/negatives/noise) needs a **push-based, list-first review surface**.

Concretely, the queue gap decomposes into:

1. **No `confirmed`/review filter on the list endpoint.** `contacts_index` / `get_contacts` support only `search` (`_crud.py:35`, `core/db/contacts/_crud.py:84`) — you cannot fetch "only unconfirmed" or "only auto-formed" contacts. A reviewer can't isolate the work.
2. **No global duplicate sweep.** `rankMergeCandidates` runs only against one selected contact (`MergePanel.tsx:187`). There is no "here are all the duplicate *pairs/clusters* across your whole contact set" view — so the owner can't see `aditya/Aditya` and `Vishnu GT ×2` *as a worklist*.
3. **No split.** No backend `split_contact` and no UI for "this one contact is actually two people." The deferred-in-ADR-058 item. Only detach-without-rehome exists.
4. **No batch confirm/reject.** Confirm is one POST per contact via a detail-panel toggle; there's no "approve all these obviously-real ones" or "reject this noise" from a list.
5. **The LCT consumer doesn't yet read `confirmed`.** The picker proxy (`known-contacts`, PR #97) dedups by name as a stand-in. Once the queue exists and contacts get confirmed, LCT should switch the picker/forbidden-list to the real `confirmed` set. **This is the only LCT-repo-side work**; everything else is TC-side.

### 2.3 Exists vs needs-building — summary

- **Backend mutation primitives:** merge ✅, confirm ✅, alias ✅, identity link/unlink ✅, cluster unlink ✅. **Missing:** a list *filter* for review, an optional global-duplicates endpoint, and (for split) a `split_contact` primitive.
- **Frontend:** detail-panel merge/confirm/alias ✅. **Missing:** a queue/worklist surface, a global-duplicates view, batch actions, and any split UX.

---

## 3. Proposed review UI

Design principle (honoring ADR-058 and the owner's "reuse, don't rebuild"): **extend `indras-ui`, reuse `mergeSuggestions.ts` + every existing endpoint, and add the *queue* as a new lens over them — not a parallel stack.** Keep words earning their place: the queue should show only what the reviewer can't already see on screen (why a contact is flagged, what a decision will do).

### 3.1 Where it mounts

**Add a "Review" lens to the existing Contacts page**, not a new top-level view. Two viable mounts:

- **(Preferred) A new `CollapsibleSection` "Needs review"** at the top of `ContactsPage.tsx` (alongside "Pending Identities", `ContactsPage.tsx:242`), OR a segmented toggle on the list panel: **Browse | Needs review**. This reuses `useContacts`, the list, and the detail panel verbatim — the queue is just a filtered, action-augmented list.
- **(Avoid)** Reusing `activeView === 'reviews'` / `UnifiedReviewPanel` — that's the media-extraction queue; overloading it would conflate two unrelated review domains.

### 3.2 Flow A — Review queue of unconfirmed contacts (the core ask)

1. Reviewer opens Contacts → **Needs review** lens.
2. The list shows **only `confirmed=0` contacts** (new `confirmed` filter, §4), ranked worst-first (bare phone-number names, 1-item imports sink or rise per a chosen order — reuse the picker's signal ranking idea from PR #97).
3. Each row gets inline actions (no detail round-trip): **Approve** (→ `POST /{id}/confirm {confirmed:true}`), **Reject/Dismiss** (see open question Q2 on what reject *does*), and **"Looks like a duplicate →"** if `rankMergeCandidates` finds a same-person match (jump to Flow B).
4. Approving removes the row from the queue (it's now confirmed). A running count ("12 to review") drives the section badge, mirroring the prayers unread-count UX (`App.tsx:325`).

### 3.3 Flow B — Merge duplicates (`aditya/Aditya`, `Vishnu GT ×2`)

- **Reuse `MergePanel` as-is** for the act of merging. The new piece is **surfacing the pairs as a worklist**: a "Likely duplicates" view that runs `rankMergeCandidates` across the loaded contact set (or a new global-duplicates endpoint, §4 — optional, for large sets) and lists candidate *clusters*.
- Picking a cluster opens the existing `MergePanel` confirm/preview flow with the survivor pre-selected (highest item_count or confirmed one as default survivor). The destructive-confirm dialog (`MergePanel.tsx:79`) and backend `confirm:true` gate (`_crud.py:194`) already protect this.

### 3.4 Flow C — Split a wrongly-clustered contact (deferred / phase 2)

ADR-058 §Consequences explicitly defers split ("merge is well-supported, split less so"). Proposed minimal viable split, built on **existing detach primitives**:

- In the detail panel, show the contact's identities + linked clusters (already available via `GET /{id}` and `GET /{id}/linked-clusters`).
- "Split off into a new person" = select a subset of identities/clusters → **(a)** `POST /api/contacts` to create the new contact, **(b)** for each selected identity `DELETE …/identities` on the old + `POST /api/contacts/link-identity` to the new, **(c)** for each cluster `POST …/unlink-cluster` on the old + `POST …/attribute` (cascade) on the new.
- This is **composable from shipped endpoints** but is **not atomic** and **does not move historical `item_participants`** rows (those were attributed to the old `contact_id`). A correct split needs a backend `split_contact(source, {identities, clusters, item_ids}) → new_contact_id` that re-points `item_participants` in one transaction — the mirror of `merge_contacts`. **Recommend: ship Flows A/B first; design split as a follow-up** (it's the genuinely new backend work, and it touches the contended `_merge.py` neighborhood).

### 3.5 Flow D — Alias edit

Already fully supported in the detail panel (`addAlias`/`removeAlias`, `contactApi.ts:91/100`). The queue just needs a shortcut into it; no new work.

---

## 4. Endpoints: exists vs new

| # | UI need | Endpoint | Status | file:line / proposed shape |
|---|---|---|---|---|
| 1 | List unconfirmed contacts for the queue | `GET /api/contacts?confirmed=0` | **NEW (small)** | Add a `confirmed: Optional[int]` query param to `contacts_index` (`_crud.py:35`) → push to `get_contacts` (`core/db/contacts/_crud.py:84`) as an extra `WHERE c.confirmed = ?`. Backwards-compatible (absent = no filter). |
| 2 | Approve a reviewed contact | `POST /api/contacts/{id}/confirm` `{confirmed:true}` | **EXISTS** | `_detail.py:133` |
| 3 | Un-approve | `POST /api/contacts/{id}/confirm` `{confirmed:false}` | **EXISTS** | `_detail.py:133` |
| 4 | Merge duplicates | `POST /api/contacts/merge` `{target, sources[], confirm:true}` | **EXISTS** | `_crud.py:175` |
| 5 | Detect duplicates for a contact | (client-side) `rankMergeCandidates` | **EXISTS** | `mergeSuggestions.ts:73` |
| 6 | Global duplicate sweep (optional, for large sets) | `GET /api/contacts/duplicate-candidates` | **NEW (optional)** | Returns candidate clusters `[{members:[contact_id…], score, reasons[]}]`. Server-side port of `rankMergeCandidates` so the UI needn't load all contacts. Only needed if the client-side sweep over the loaded page proves insufficient. |
| 7 | Alias add / remove | `POST` / `DELETE /api/contacts/{id}/aliases` | **EXISTS** | `_aliases_identities.py:68/84` |
| 8 | Identity attach / remove | `POST` / `DELETE /api/contacts/{id}/identities` | **EXISTS** | `_aliases_identities.py:100/118` |
| 9 | Unlink a face/voice cluster | `POST /api/contacts/{id}/unlink-cluster` | **EXISTS** | `_aliases_identities.py:40` |
| 10 | Show linked clusters (for split) | `GET /api/contacts/{id}/linked-clusters` | **EXISTS** | `_aliases_identities.py:28` |
| 11 | Create a contact (for split target) | `POST /api/contacts` | **EXISTS** | `_crud.py:114` |
| 12 | **Atomic split** | `POST /api/contacts/{id}/split` `{identities[], face_clusters[], voice_clusters[], item_ids[], new_display_name}` → `{new_contact_id}` | **NEW (phase 2)** | The mirror of `merge_contacts`: in one `BEGIN IMMEDIATE` txn, create the new contact, re-home the selected identities + clusters + `item_participants` rows, recompute counters. Lives next to `_merge.py`. |
| 13 | (optional) Batch confirm | `POST /api/contacts/confirm-batch` `{contact_ids[], confirmed:bool}` | **NEW (optional)** | Convenience over #2; or the UI just fires N parallel `/confirm` calls. Prefer the loop unless N is large. |

**Net new backend:** #1 (tiny, ship first), optionally #6, and #12 for split (the real work). Everything merge/confirm/alias/identity is shipped.

---

## 5. Incremental build plan (smallest-first; each independently shippable)

> **TC = contended repo (TemporalCoordination/IndrasNet); coordinate before touching.** LCT = the live-conversational-threads repo.

1. **[TC, backend, tiny] Add `confirmed` filter to the list endpoint.** Query param on `contacts_index` (`_crud.py:35`) → `get_contacts` WHERE clause. Backwards-compatible. Unit test: `?confirmed=0` returns only unconfirmed. *This unblocks the entire queue.*
2. **[TC, frontend] "Needs review" lens.** A segmented **Browse | Needs review** toggle (or a `CollapsibleSection`) on `ContactsPage.tsx` that calls `listContacts(..., {confirmed:0})` and renders the existing `ContactListPanel` with a count badge. Reuses everything.
3. **[TC, frontend] Inline Approve / Unconfirm in the queue rows.** Wire `setContactConfirmed` (`contactApi.ts:148`) to per-row buttons; row leaves the queue on approve. No backend change.
4. **[TC, frontend] "Looks like a duplicate" hint in queue rows.** Run `rankMergeCandidates` (`mergeSuggestions.ts:73`) for each queued contact against the loaded set; if a strong match, show a "Merge →" affordance that opens the existing `MergePanel` flow. No backend change.
5. **[TC, frontend] Global "Likely duplicates" worklist** (still client-side sweep over loaded contacts). A list of candidate clusters → each opens `MergePanel`. Ship #6 (server-side sweep) only if the client sweep is too slow on the real contact count.
6. **[LCT, consumer] Switch the picker/forbidden-list to the real `confirmed` signal.** Replace PR #97's name-dedup proxy in `known-contacts` with a filter on `confirmed`. Honors ADR-038. *Only LCT-side step.*
7. **[TC, backend — the real new work] `POST /{id}/split` atomic primitive** (#12) + its detail-panel UI (Flow C). Deferred per ADR-058; do last. Touches the `_merge.py` neighborhood, so sequence it when TC contention is low.
8. **[TC, optional] Batch confirm** (#13) if step-3's per-row loop feels slow at scale.

Steps 1-5 deliver the core ADR-058 §2 ask (review + merge + confirm queue) using **one tiny backend change + frontend that reuses shipped endpoints**. Step 6 closes the LCT loop. Step 7 is the genuinely new backend feature (split).

---

## 6. Open questions (genuine design forks)

1. **Queue ordering & "auto-formed" detection.** `confirmed=0` is the obvious queue filter, but it conflates *never-reviewed* with *actively-rejected*. Do we need a third state (e.g. `reviewed_at` timestamp, or a `rejected` flag) so a dismissed-as-noise contact doesn't keep reappearing in the queue forever? Today `confirmed` is a bare 0/1 — there's no "I looked and said no" distinct from "not looked at yet." **Fork: add a `reviewed_at` / tri-state, or treat `confirmed=0` + some heuristic (item_count, name shape) as "needs review" and accept that rejected-noise lingers.**
2. **What does "Reject" do to a noise contact** (bare phone number, 1-item import)? Options: (a) just leave it `confirmed=0` (inert but clutters the queue — see Q1); (b) hard-delete the contact; (c) a soft `archived`/`hidden` flag (new column). Delete is destructive and may strand `item_participants`; a hidden flag is safer but is new schema. **Fork: pick the reject semantics.**
3. **Split scope & atomicity.** Is the deferred split worth a dedicated atomic `split_contact` backend primitive (correct, re-homes `item_participants`, mirrors merge — more TC work), or is a UI-composed best-effort split from existing detach+create+link endpoints (non-atomic, leaves history attributed to the old contact) acceptable for v1? **Fork: atomic primitive vs composed best-effort.**

---

## Appendix — audit notes

- **"indrajala" does not exist** as a directory; the IndrasNet frontend is `grimoire/IndrasNet/indras-ui/` (`package.json` name `indras-ui`). ADR-058 §1 should be corrected to name `indras-ui`.
- The contacts route package was split from a monolith in the "B6" sweep (`__init__.py:11`); endpoint registration order matters (`__init__.py:48-61`).
- `confirmed` is an additive ADR-009 migration column (`schema.py:990`), NOT in the base `contacts` DDL (`schema.py:279-287`) — anything querying it must tolerate the column being absent on a very old DB (the migration backfills it).
- Merge is codex-hardened (PR #61): atomic txn, most-restrictive consent, generic FK re-attribution, fail-closed `MergeConflictError`. Reuse it; do not reimplement merge logic in the queue.
