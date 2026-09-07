"""Audit a diagnostic verifier's quotes, without claiming semantic entailment.

Source existence and inclusion in original selected citations are different
checks. Neither proves the verifier decomposed every claim or understood it.
"""


def audit_atomic_response(response, request):
    observations = {o['id']: o for o in request['observations']}
    spans = {s['span_id']: s['text'] for s in request['source']}
    reviews = response.get('reviews') if isinstance(response, dict) else None
    if not isinstance(reviews, list):
        raise ValueError('Atomic verifier must return reviews')
    seen, audited = set(), []
    for review in reviews:
        identity = review.get('observation_id') if isinstance(review, dict) else None
        if not isinstance(identity, str) or identity not in observations or identity in seen:
            raise ValueError('Atomic verifier repeated or invented an observation')
        seen.add(identity)
        claims = review.get('claims')
        if not isinstance(claims, list) or not claims:
            raise ValueError('Atomic verifier must supply individual claims')
        selected = observations[identity]['citations']
        for claim in claims:
            if not isinstance(claim, dict) or not isinstance(claim.get('claim'), str) or not claim['claim'].strip():
                raise ValueError('Atomic claim text required')
            citations = claim.get('citations')
            if not isinstance(citations, list):
                raise ValueError('Atomic claim citations required')
            coverage = []
            for citation in citations:
                if not isinstance(citation, dict):
                    raise ValueError('Atomic citation must be an object')
                sid, quote = citation.get('span_id'), citation.get('quote')
                if (not isinstance(sid, str) or sid not in spans or not isinstance(quote, str)
                        or not quote.strip() or quote not in spans[sid]):
                    raise ValueError('Verifier quote is absent from its claimed source span')
                coverage.append(any(c['span_id'] == sid and quote in c['quote'] for c in selected))
            actual = 'missing' if not coverage else ('selected' if all(coverage) else 'elsewhere')
            asserted = claim.get('support')
            if asserted not in {'selected', 'elsewhere', 'missing', 'ambiguous'}:
                raise ValueError('Atomic support disposition invalid')
            audited.append({'observation_id': identity, 'claim': claim['claim'],
                'asserted_support': asserted, 'citation_location': actual,
                'support_label_mismatch': asserted != 'ambiguous' and asserted != actual})
    if seen != set(observations):
        raise ValueError('Atomic verifier omitted observations')
    return {'claims': audited,
            'observations_requiring_citation_revision': sorted({c['observation_id'] for c in audited
                if c['citation_location'] in {'elsewhere', 'missing'}}),
            'semantic_entailment_verified': False,
            'claim_coverage_verified': False}
