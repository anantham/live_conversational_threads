"""Resolve explicit current-passage support without filling gaps between turns.

The model selects source lines, not UUIDs. These selections establish provenance
only: whether the selected text entails the summary still needs semantic review.
"""
from __future__ import annotations


def selected_leaf_sources(nodes, text_batch, utterance_ids_batch):
    """Validate all selections before returning index-to-utterance-ID bindings.

    Nodes without source_line_ids retain the legacy display-quote path. Callers
    activating the new interpreter contract must separately require the field.
    No node or input source is modified, including on validation failure.
    """
    selected_nodes = [(index, node) for index, node in enumerate(nodes)
                      if isinstance(node, dict) and 'source_line_ids' in node]
    if not selected_nodes:
        return {}
    if len(text_batch) != len(utterance_ids_batch):
        raise ValueError('Leaf evidence source fragments and identity slots differ')
    lines = {}
    seen = set()
    for index, (text, ids) in enumerate(zip(text_batch, utterance_ids_batch)):
        if (not isinstance(text, str) or not isinstance(ids, (list, tuple))
                or not ids):
            raise ValueError('Leaf evidence requires text and nonempty source identity slots')
        resolved = [str(identity) for identity in ids if identity is not None]
        if (len(resolved) != len(ids) or any(not identity.strip() for identity in resolved)
                or len(set(resolved)) != len(resolved) or seen.intersection(resolved)):
            raise ValueError('Leaf evidence source identities must be distinct and nonempty')
        seen.update(resolved)
        lines[f'line-{index}'] = (index, resolved)
    bindings = {}
    for index, node in selected_nodes:
        if node.get('semantic_level', node.get('level', 1)) != 1:
            raise ValueError('Current source-line selections belong only to leaf nodes')
        selection = node['source_line_ids']
        if (not isinstance(selection, list) or not selection
                or any(not isinstance(identity, str) or identity not in lines for identity in selection)
                or len(selection) != len(set(selection))):
            raise ValueError('Leaf evidence requires distinct known current source line IDs')
        selected = [identity for line in sorted(selection, key=lambda key: lines[key][0])
                    for identity in lines[line][1]]
        if node.get('utterance_ids') and node['utterance_ids'] != selected:
            raise ValueError('Leaf evidence conflicts with existing authored source identities')
        bindings[index] = selected
    return bindings
