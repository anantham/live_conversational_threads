"""Assemble journal recovery and bounded backlog processing for a live session."""
from lct_python_backend.services.transcript.passage_pump import PassagePump, read_owned_source_page


async def prepare_live_passages(*, config, conversation, owner_id, providers,
                                send_update, send_status, processor_lock):
    if conversation.owner_id != owner_id or conversation.deleted_at is not None:
        raise PermissionError("Conversation unavailable to this owner")
    metadata = conversation.source_metadata if isinstance(conversation.source_metadata, dict) else {}
    processor = config.build(
        conversation_id=str(conversation.id), owner_id=owner_id, providers=providers,
        privacy=metadata.get("privacy"), send_update=send_update, send_status=send_status,
    )
    # Conversation/source commit precedes this call. A changed policy or a
    # legacy graph fails here rather than silently creating an empty session.
    await processor._passage_commit.recover()
    state = await processor._passage_commit.journal.recover()

    async def read_page(after, limit):
        return await read_owned_source_page(config.session_factory,
            conversation_id=str(conversation.id), owner_id=owner_id, after_sequence=after, limit=limit)

    pump = PassagePump(processor=processor, read_page=read_page,
                       committed_sequence=state["committed_through"], processor_lock=processor_lock)
    return processor, pump
