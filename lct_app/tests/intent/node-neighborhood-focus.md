# Test Intent: node-centred relationship view

- Clicking a graph card reorients the current tier around that node instead of drilling or opening details.
- The focused view shows only the node, its direct incoming/outgoing neighbours, and their incident edges.
- Direction remains visible through deterministic above/centre/below placement and edge labels.
- `Details` and `Expand` remain explicit, independent actions on every applicable card.
- `Show all` and Escape restore the unfiltered tier without mutating the conversation artifact.
- Timeline/detail navigation to a node outside the active neighbourhood first restores the full tier, then centres the requested node.
- Enter or Space on a keyboard-focused graph card performs the same neighbourhood focus as pointer activation.
- Representation-only changes such as speaker/color mode do not overwrite a reader's pan or zoom inside an active neighbourhood.
- Focus status is announced to assistive technology and its mobile exit meets the 44px touch-target floor.
- Speaker color is the default visual identity; relation styling remains on edges.
