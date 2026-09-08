"""Three synthetic turns through the actual local interpreter contract.

No private conversation, DB mutation, external provider, retries or deployment.
This is a semantic diagnostic; passing it is not full pipeline acceptance.
"""
import json
import argparse
import time

from lct_python_backend.services.transcript.inference_envelope import InferenceEnvelope
from lct_python_backend.services.transcript.interleaved_prompt import INTERLEAVED_SYSTEM_PROMPT
from lct_python_backend.services.transcript.conversation_context import plan_conversation_context
from lct_python_backend.services.transcript.question_memory import fold_question_memory


PASSAGES = [
    "Mira: Who will cover the server costs after our grant ends? I can ask the foundation, but I have no answer yet. Sam: Before we send any recordings to a hosted AI service, do we have consent from every participant? We still need to ask them.",
    "Mira: The garden volunteers are planting roses on Saturday. Sam: I can bring a spade, and Jo can bring the watering can. Mira: Great, let's meet at nine.",
    "Mira: Returning to that unanswered funding question, the foundation declined. I will personally pay the hosting bill for the next three months, but beyond that we don't know. Sam: And on sending recordings outside, one participant said no. We will keep this conversation on the owner's machine. That does not mean consent for future meetings is settled.",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--held-out", action="store_true")
    args = parser.parse_args()
    passages = PASSAGES if not args.held_out else [
        "Nora: Are residents allowed to make spare front-door keys? I have asked the property manager, but she has not replied. Luis: I do not know either.",
        "Luis: Venus was very bright last night. Nora: I watched it until clouds covered the sky. Luis: I enjoyed being outside.",
        "Nora: The property manager finally replied about those copies. Residents may make up to two spare keys. She did not say whether we may lend them to visitors, so I still need to ask about that.",
    ]
    envelope = InferenceEnvelope(
        system_prompt=INTERLEAVED_SYSTEM_PROMPT,
        providers=[{"id": "local-question-probe", "model": "qwen3.8:27b-mlx",
                    "base_url": "http://127.0.0.1:11434", "type": "openai_compatible",
                    "trust_scope": "owner_private", "context_tokens": 32768, "timeout_seconds": 180}],
        privacy={"local_llm_ok": True}, output_tokens=2048, headroom_tokens=512, temperature=0,
        require_leaf_sources=True,
    )
    nodes, chunks = [], {}
    for index, source in enumerate(passages):
        plan = plan_conversation_context(source, nodes, chunks, {}, envelope.context_policy())
        print(json.dumps({"phase": "requesting", "passage": index, "input_estimate_bytes": plan.estimated_tokens}), flush=True)
        started = time.monotonic()
        generated, backend = envelope.generate(plan.prompt)
        cid = f"synthetic-{index}"
        candidate = [{**node, "chunk_id": cid} for node in generated]
        prospective_chunks = {**chunks, cid: source}
        memory = fold_question_memory(nodes + candidate, prospective_chunks)
        nodes.extend(candidate)
        chunks = prospective_chunks
        print(json.dumps({"phase": "complete", "passage": index, "seconds": round(time.monotonic() - started, 2),
                          "backend": backend, "nodes": candidate, "question_memory": memory}), flush=True)


if __name__ == "__main__":
    main()
