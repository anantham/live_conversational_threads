# Central provider and prompt settings on Sites

**Date** 2026-11-24

**Status** Implemented for local Sites preview.

## Decision

Keep one Sites Settings screen for provider selection and keys, with separate ranked lists for speech-to-text and map generation. Recording, meetings and file import consume the same browser preferences and show the eligible recipients at consent time. A user may choose multiple providers. Personal keys stay in memory for one tab. Provider order, nonsecret model selections and map prompt guidance stay on the device.

Soniox live sessions and audio-file streaming use scoped temporary credentials. OpenAI can process audio files through the existing personal-key transcription client. Only Soniox supports the live Sites transport. Personal mapping providers share the hosted generation admission ledger, output caps and request deadline. The existing direct routes remain callable and retain their prior behavior. The ordered route advances following a definitive refusal or unavailable configuration and preserves the existing graph and source validation. No new storage tables are required.

The Sites prompt editor shows the built-in map prompt and applies user guidance without relying on the Python prompt library. The existing backend prompt editor continues to manage its own versioned templates.

## Validation and release

Test with synthetic transcripts, synthetic credentials and intercepted provider transport. Validate browser ordering and key lifetime at desktop and mobile widths. A release or a paid hosted pilot requires the applicable host access and operational approval.

## Amendment — 2026-11-24

The user asked to keep personal keys and model lists between visits. Save the key encrypted in IndexedDB on the current browser profile and origin. Keep a per-record, nonextractable Web Crypto key in the same store so the app can reopen the credential. This protects against casual plaintext exposure in storage. Application code on the same origin can still use the credential. There is no server-side credential persistence.

Intelligence requests provider model metadata on save and on explicit refresh. The last successful catalog stays available on reload. Remove clears both the credential and its catalog. A provider catalog response can update only the credential revision that initiated it. Model selections and fallback order remain separate preferences so they can be reused when a key is replaced.
