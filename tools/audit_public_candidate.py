"""Structural checks for the two public artifacts, never semantic acceptance.

Run with a candidate path. Source is the SHA-pinned public podcast. Reports
missing source, hierarchy, thread identity or playback before browser review.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
from tools.replay_public_source_inspection import verified_public_source, FIELDS


def audit(bundle, source):
    problems = []
    actual = bundle.get('utterances', [])
    if [{k:u.get(k) for k in FIELDS} for u in actual] != [{k:u.get(k) for k in FIELDS} for u in source]:
        problems.append('Exported source fields differ from pinned original')
    nodes = bundle.get('graph_data', [])
    ids = [n.get('id') for n in nodes]
    if not ids or len(set(ids)) != len(ids) or any(not i for i in ids):
        problems.append('Empty or duplicate graph node IDs')
    levels = Counter(n.get('semantic_level') for n in nodes)
    missing = sorted(set(range(1, 6)) - set(levels))
    if missing:
        problems.append(f'Missing authored abstraction levels: {missing}')
    threads = {n.get('thread_id') for n in nodes if n.get('thread_id')}
    if len(threads) < 2:
        problems.append('Fewer than two identified conversation threads')
    source_ids = {u['id'] for u in source}
    covered = set()
    for node in nodes:
        evidence = set(node.get('utterance_ids') or [])
        if evidence - source_ids:
            problems.append(f'Foreign utterance reference: {node.get("id")}')
        if node.get('semantic_level') == 1:
            covered.update(evidence)
        if node.get('parent_id') and node['parent_id'] not in ids:
            problems.append(f'Missing parent: {node.get("id")}')
    expected_video = '6HmR9IaqM88'
    if not any(r.get('provider') == 'youtube' and r.get('video_id') == expected_video
               and r.get('view_url') == f'https://www.youtube.com/watch?v={expected_video}'
               for r in bundle.get('media_refs', [])):
        problems.append('Missing pinned YouTube playback reference')
    return {'structural_problems': problems, 'node_count': len(nodes),
            'levels': dict(levels), 'thread_count': len(threads),
            'source_utterances': len(actual), 'level1_evidence_utterances': len(covered),
            'semantic_acceptance': 'pending human-visible source review',
            'publication_accepted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidate', type=Path)
    args = parser.parse_args()
    result = audit(json.loads(args.candidate.read_text()), verified_public_source())
    print(json.dumps(result, indent=2))
    raise SystemExit(bool(result['structural_problems']))
