# Derived parent evidence (2026-11-25)

- A higher-tier node's evidence is its own cited utterances plus every child filed under it
  (primary parent only), so the model need not repeat child IDs at every tier.
- Evidence flows through all tiers: an arc covers the chunks under its themes, topics and ideas.
- Derivation never adds, drops or moves a relationship; invalid IDs and missing parents still
  reach the existing validator unchanged and are rejected there.
- Driver: Claude window 1 of a 93-minute import was truncated at 12,000 of 12,000 output tokens
  (Anthropic req_011ChNrTYYP6D7aVojqdY98S) while the prompt required that repetition.
