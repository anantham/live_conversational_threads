# ADR-063: Personal-Private Retention and Explicit Provider Trust

- **Date:** 2026-08-15
- **Status:** Approved
- **Group:** Privacy / deployment / inference routing
- **Related:** ADR-034, ADR-038, ADR-059

## Issue

The Indra's Net meeting pipeline must be able to push a high-quality original
transcript into the owner's own LCT instance so LCT can construct an auditable
`.threads` graph before contextual privacy transformation. The existing raw-turn
endpoint instead rejected every unredacted transcript unless the operator set a
low-level `LCT_MIRROR_RAW` escape hatch.

At the same time, LCT persisted conversation privacy metadata without enforcing
it when graph extraction selected LLM providers. A provider's URL or name is not
a trustworthy indicator of where transcript content goes. Graph persistence
also replaced `source_metadata`, which could erase the privacy decision after a
successful extraction.

## Decision

LCT has two explicit deployment profiles:

| Profile | Raw transcript retention |
| --- | --- |
| `personal_private` | Allowed; this is the default for the owner-operated local installation |
| `hosted_shared` | Refused; callers must submit a privacy-transformed transcript |

Each LLM provider also has an explicit trust scope:

| Trust scope | Meaning |
| --- | --- |
| `owner_private` | The operator asserts that the provider runs within the owner's private boundary |
| `external` | Transcript content may cross that boundary |

The extraction path intersects those scopes with the conversation's affirmative
privacy flags:

- `local_llm_ok=true` permits enabled `owner_private` providers.
- `external_llm_ok=true` permits enabled `external` providers.
- Missing privacy flags, no permitted enabled provider, or an unknown deployment
  profile stops extraction with a content-free diagnostic.
- Missing or invalid provider trust metadata is treated as `external`; trust is
  never inferred from a loopback, LAN, or Tailscale-looking URL.
- When `external_llm_ok=false`, the legacy direct online-model branch is forced
  into local mode as well as filtering the provider list.
- Graph enrichment merges into existing `source_metadata` so the privacy block
  survives extraction and reprocessing.

The owner review gate remains outside LCT. Producing a graph, `.threads` file,
or owner-only Google Doc never grants recipient Drive access and never sends an
email. Those effects require the human to press **Execute** in Indra's Net.

## Assumptions

- The default installation is a single-owner clone running on hardware and
  accounts controlled by that owner.
- Indra's Net chooses and pushes the meeting; LCT does not receive broad read
  access to the Indra's Net database.
- Provider trust is operator-authored configuration, not dynamically attested.
- The MVP needs major participant privacy norms and owner review, not a complete
  moral-case retrieval system before the first end-to-end artifact ships.

## Considered positions

1. **Keep raw retention off everywhere.** Safest generic-server default, but it
   makes the owner's local fork unusable as the auditable pre-transformation
   workspace and forces premature information loss.
2. **Allow raw retention whenever an environment boolean is set.** Small, but
   it expresses no deployment model and does not solve inference egress.
3. **Deployment profile plus explicit provider trust scopes.** Chosen because
   retention and inference are separate boundaries and both fail closed where
   ambiguity matters.
4. **Give LCT direct database access to Indra's Net.** Rejected because it
   broadens privilege and couples two systems unnecessarily.

## Argument

`personal_private` makes the normal self-hosted case usable without pretending
the transcript is already redacted. `hosted_shared` preserves consent-first
behavior for third-party hosting. Explicit provider scopes avoid the dangerous
assumption that network location equals privacy, while conversation-level flags
keep the participant decision attached to the actual data being processed.

This is intentionally a narrow MVP: it establishes a defensible boundary and
leaves context-retrieval tools, richer participant norms, and automatic standing
shares for later decisions.

## Consequences

- Existing custom providers without `trust_scope` become external and cannot
  process a private-only conversation until the operator classifies them.
- Startup rejects a misspelled deployment profile rather than silently choosing
  a weaker behavior.
- The backend API can persist provider scopes now. A dedicated settings control
  for changing them remains follow-up UI work; until then the operator must use
  the authenticated settings API/configuration path.
- This is policy enforcement, not cryptographic isolation. Hosted deployments
  still need the egress controls described in ADR-034/038.

## Validation contract

- `personal_private` accepts explicit raw-turn retention without the retired
  escape hatch.
- `hosted_shared` rejects it even if `LCT_MIRROR_RAW=1` remains in an old env.
- A private-only extraction passes only `owner_private` providers and disables
  the direct online branch.
- Missing privacy or trust metadata fails closed.
- Graph enrichment preserves the original privacy metadata.

## Fallback

If the profile or provider classification is uncertain, switch the deployment
to `hosted_shared` or leave providers classified `external`. Extraction will
stop with a diagnostic; the original transcript remains in Indra's Net and can
be replayed after configuration is corrected.

