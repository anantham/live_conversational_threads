"""Public-only replay bootstrap; never creates schemas or overwrites evidence."""
from datetime import datetime, timezone
import json
import re
import uuid

from sqlalchemy import select
from sqlalchemy.engine import make_url
from lct_python_backend.models import Conversation, Utterance, Node, PipelineArtifact
from tools.replay_public_source_inspection import SHA, FIELDS, verify_rows


def validate_target(database_url, run_id):
    url = make_url(database_url)
    if (url.drivername != 'postgresql+asyncpg' or url.host not in {'127.0.0.1', '::1'}
            or not url.port or not url.username or url.query
            or not re.fullmatch(r'lct_public_replay_[a-z0-9_]{1,40}', url.database or '')):
        raise ValueError('Require explicit loopback PostgreSQL lct_public_replay_* database without URL options')
    if not isinstance(run_id, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', run_id):
        raise ValueError('Run ID must be 1-64 alphanumeric, dash or underscore characters')
    return url


def replay_identity(run_id):
    return uuid.uuid5(uuid.NAMESPACE_URL, f'lct-public-full-replay:6HmR9IaqM88:{SHA}:{run_id}')


async def ensure_replay(db, *, run_id, owner_id, source, policy, resume=False):
    """Caller supplies verified pinned source and encloses this in one transaction."""
    if not isinstance(owner_id, str) or not owner_id.strip():
        raise ValueError('Configured owner is required')
    cid = replay_identity(run_id)
    metadata = {'public_source_sha256': SHA, 'youtube_video_id': '6HmR9IaqM88',
                'replay_run_id': run_id, 'replay_policy': policy,
                'privacy': {'local_llm_ok': True, 'external_llm_ok': False}}
    if resume:
        conversation = await db.get(Conversation, cid)
        if (conversation is None or conversation.owner_id != owner_id or conversation.deleted_at is not None
                or conversation.source_metadata != metadata):
            raise ValueError('Resume source, owner, run or policy differs; no overwrite permitted')
        other = (await db.execute(select(Conversation.id).where(Conversation.id != cid).limit(1))).scalar_one_or_none()
        if other is not None:
            raise ValueError('Resume database contains another conversation; isolation required')
        rows = (await db.execute(select(Utterance).where(Utterance.conversation_id == cid)
                                .order_by(Utterance.sequence_number))).scalars().all()
        verify_rows(rows, source)
        return cid
    for model in (Conversation, Utterance, Node, PipelineArtifact):
        if (await db.execute(select(model.id).limit(1))).scalar_one_or_none() is not None:
            raise ValueError('Fresh replay requires empty source/graph/checkpoint tables; use a new isolated database')
    db.add(Conversation(id=cid, owner_id=owner_id,
        conversation_name='Public podcast: isolated interleaved full replay',
        conversation_type='transcript', source_type='public_youtube_replay', visibility='private',
        started_at=datetime.now(timezone.utc), source_metadata=metadata))
    await db.flush()
    for original in source:
        values = {field: original.get(field) for field in FIELDS}
        values['id'] = uuid.UUID(values['id'])
        db.add(Utterance(conversation_id=cid, **values))
    await db.flush()
    return cid


def inference_receipt(envelope, prompt, response):
    # Same renderer as complete_json; retain exact whitespace and serving evidence.
    return {'messages': envelope._messages(prompt), 'response': response.data,
            'source_sha256': SHA, 'policy_fingerprint': envelope.fingerprint,
            'tokenizer_id': envelope.tokenizer_id,
            'requested_models': [p['model'] for p in envelope.providers],
            'reasoning_efforts': [p.get('reasoning_effort', 'none') for p in envelope.providers],
            'served_model': response.model, 'cache_hit': response.cache_hit,
            'prompt_tokens': response.prompt_tokens, 'completion_tokens': response.completion_tokens,
            'finish_reason': response.finish_reason}


def record_inference(output, envelope, prompt, invoke):
    """Public replay only: retain a request even if invocation never returns."""
    call = output / f'inference-{uuid.uuid4().hex}'
    call.mkdir(exist_ok=False)
    request = {'messages': envelope._messages(prompt), 'source_sha256': SHA,
               'policy_fingerprint': envelope.fingerprint, 'tokenizer_id': envelope.tokenizer_id,
               'requested_models': [p['model'] for p in envelope.providers]}
    (call / 'request.json').write_text(json.dumps(request, ensure_ascii=False), encoding='utf-8')
    try:
        response = invoke(envelope, prompt)
    except Exception as error:
        # Provider exception text may include credentials or transport bodies.
        (call / 'failure.json').write_text(json.dumps(
            {'status': 'failed', 'error_type': type(error).__name__}), encoding='utf-8')
        raise
    (call / 'response.json').write_text(json.dumps(
        inference_receipt(envelope, prompt, response), ensure_ascii=False), encoding='utf-8')
    return response
