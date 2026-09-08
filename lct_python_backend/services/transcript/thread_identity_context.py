"""Bounded candidate review over committed occurrences, never future utterances."""
import re

CANDIDATE_POLICY = 'latest_passage_same_id_lexical_top4_v1'


def identity_candidates(nodes, chunks):
    """At most four pairs per latest committed passage; not exhaustive identity."""
    eligible = [n for n in nodes if n.get('thread_id') and n.get('id') and n.get('chunk_id') in chunks]
    if not eligible:
        return []
    latest = eligible[-1]['chunk_id']
    scored = []
    def terms(node):
        return set(re.findall(r'\w{3,}', (str(node.get('thread_label', '')) + ' ' +
                                         str(node.get('summary', ''))).casefold()))
    for current in (n for n in eligible if n['chunk_id'] == latest):
        for earlier in (n for n in eligible if n['chunk_id'] != latest):
            shared = len(terms(current) & terms(earlier))
            same_id = current['thread_id'] == earlier['thread_id']
            if shared or same_id:
                pair = tuple(sorted((current['id'], earlier['id'])))
                scored.append((-(int(same_id)), -shared, pair))
    return [list(pair) for _, _, pair in sorted(set(scored))[:4]]


class ThreadIdentityContextReader:
    def __init__(self, runner):
        self.runner = runner

    async def __call__(self, nodes, chunks, mapping):
        from .thread_identity_runner import export_thread_identity_reviews
        await self.runner.run(identity_candidates(nodes, chunks))
        async with self.runner.sessions() as db:
            exported = await export_thread_identity_reviews(db, **self.runner.scope,
                expected_state={'nodes': nodes, 'chunks': chunks, 'utterance_chunk_map': mapping})
        policies = [p for p in exported['policies'] if p['policy_fingerprint'] == self.runner.fingerprint]
        if len(policies) > 1:
            raise ValueError('Multiple current thread identity policies')
        return policies[0]['annotations'] if policies else []
