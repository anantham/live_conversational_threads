"""Derive a five-second caption-audio overlay from the exact recovered public source.

No runtime startup, network, secrets or source overwrite. Keep the upstream checkout
clean; only explicitly requested caption-plus-audio-chunks bots get a shorter buffer.
"""
import hashlib
import json
from pathlib import Path
import sys

UPSTREAM_SHA = "6a696a0fea24e8f7c30ebbc7be173e1fb8c873badaa27b943410cbb9b7e03cf7"
OLD = "    def non_streaming_audio_utterance_size_limit(self):\n"
NEW = OLD + "        if self.save_utterances_for_closed_captions() and self.bot_in_db.record_async_transcription_audio_chunks():\n            return self.get_per_participant_audio_sample_rate() * 2 * 5  # bounded live audio parts\n"

def prepare(source, destination):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != UPSTREAM_SHA:
        raise ValueError("Recovered controller source identity differs")
    text = raw.decode("utf-8")
    if text.count(OLD) != 1:
        raise ValueError("Expected audio-buffer declaration missing or ambiguous")
    result = text.replace(OLD, NEW)
    compile(result, "bot_controller.py", "exec")
    out = Path(destination)
    out.mkdir(exist_ok=False)
    (out / "bot_controller.py").write_text(result)
    (out / "Dockerfile").write_text("FROM lct-attendee:recovery-500168b1\nCOPY --chown=app:app bot_controller.py /attendee/bots/bot_controller/bot_controller.py\nRUN python -c \"compile(open('/attendee/bots/bot_controller/bot_controller.py').read(), 'bot_controller.py', 'exec')\"\n")
    receipt = {"upstream_sha256": UPSTREAM_SHA, "controller_sha256": hashlib.sha256(result.encode()).hexdigest(), "max_part_seconds": 5}
    (out / "prepared.json").write_text(json.dumps(receipt, indent=2))
    return receipt

if __name__ == "__main__":
    print(json.dumps(prepare(*sys.argv[1:])))
