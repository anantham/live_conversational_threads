# Viewer graph navigation snapshot — test intent

- A tier, drill, or relationship focus change yields a compact history snapshot keyed by node IDs and levels, with no source text.
- Camera-only moves replace the current entry; a saved camera and graph tier survive leaving Graph and returning, and Back/Forward restores them without another history entry.
- Restoration waits for the restored node set to be measured and does not let automatic fit, focus, or follow motion overwrite its camera.
- Speaker contribution labels resolve current artifact aliases while speaking fractions and speaker identity IDs stay unchanged.
