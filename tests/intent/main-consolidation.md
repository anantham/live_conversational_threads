# Main/cloud integration intent

- Main viewer navigation, source playback/search, speaker actions and selected-card framing survive alongside Sites private/public/ephemeral routes. No automatic persistence/publication is introduced for private or ephemeral content.
- Source speaker/provenance color ownership and diagnostics suppression remain; existing main and cloud behavioral regressions pass together.
- Combined existing dependencies produce consistent lockfile and both ordinary Vite and Sites Worker builds, without a new package choice.
- Every existing migration and runtime flag remains byte-identical; source merge sends no STT/model/bot request or production data write. Preserve both branches and unrelated dirty/parked files.
- Main merge requires exact independent review plus applicable CI. A prepared merge or passing fixture suite is not delivery until canonical main is verified.
