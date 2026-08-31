# ADR-066: Explicit Local STT Authority Set

**Status:** Approved
**Date:** 2026-08-31
**Decider:** Aditya
**Group:** Integration and Privacy
**Related:** ADR-017, ADR-020, ADR-023, ADR-056, ADR-061, ADR-063

## Issue

Saved provider settings currently mix preference, reachability, and authority.
A dormant strict-M5 branch removed silent cloud fallback but treated one URL as
machine identity and made a sleeping M5 a total pipeline stop. The owner needs
privacy-preserving local fallback without allowing ordinary settings or stale
queued state to authorize cloud egress.

## Decision

Automatic STT uses an explicit ordered authority record. The owner-approved
order is M5 first and Asus second. Each authority has a stable ID, configured
endpoint/provider capabilities, and enabled state. Resolver outputs carry the
authority ID that granted the route; URL shape is never treated as identity.

Ordinary live/import provider preferences cannot add a cloud route. Cloud STT
is eligible only when a validated session-scoped BYOK grant authorizes the
requested provider. If every approved local authority is unavailable and no
such grant exists, the request fails with a descriptive local-authority
exhaustion error. It never silently falls through to a saved cloud key.

The same resolved candidate governs live, ordinary import, segmented import,
and sequential import. Large cloud-BYOK imports remain on the provider-aware
sequential path. Delayed jobs remain credential-free and resolve authority
again when they run.

## Positions Considered

1. M5-only automatic routing. Rejected because laptop sleep becomes a total
   outage.
2. **M5 primary plus Asus approved local fallback (chosen).** Preserves the
   local privacy boundary while tolerating one unavailable machine.
3. Keep provider preference as authority. Rejected because it permits silent
   cloud degradation and stale queued decisions.

## Consequences

- Authority configuration, not a hostname heuristic, determines which local
  machines may receive audio.
- Reachability chooses among approved candidates but cannot expand the set.
- Public/serverless BYOK remains a separate scoped mechanism under ADR-060.
- Endpoint attestation is a future hardening step; this decision establishes
  explicit configuration trust rather than claiming cryptographic identity.

## Verification

Behavioral tests must cover M5 primary, Asus fallback, local exhaustion, no
silent cloud, scoped BYOK, large BYOK imports, consistent segmented/sequential
routing, and credential-free delayed jobs.

## Implementation Note — 2026-08-31

Implemented as one shared authority resolver contract consumed by live,
sequential import, and segmented import. Delayed jobs discard request/session
authority and rebuild the current environment-owned M5→Asus set when they
execute. Websocket capability is explicit: an HTTP URL never implies a
realtime endpoint. The Asus default therefore names its websocket URL as a
separate owner-controlled setting.

The previous preference/hostname routing implementation was removed rather
than retained as a compatibility path. Provider overrides and saved cloud
settings remain preferences; only the internal marker minted by a validated
BYOK session grants cloud authority.
