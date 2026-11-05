"""Derive float-safe RMS from pinned public audio manager; no runtime action."""
import hashlib
import json
from pathlib import Path
import sys
UPSTREAM_SHA = '24156fdfee8f8e0fc67b05605b3e97ea6f8e50dd804a4417bb893156f7981d6c'

def prepare(source, destination):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != UPSTREAM_SHA:
        raise ValueError('Pinned audio manager differs; preserve and inspect it')
    old = 'samples = np.frombuffer(audio_bytes, dtype=np.int16)'
    text = raw.decode('utf-8')
    if text.count(old) != 1:
        raise ValueError('RMS calculation point differs')
    text = text.replace(old, old + '.astype(np.float32)')
    compile(text, 'per_participant_non_streaming_audio_input_manager.py', 'exec')
    out = Path(destination)
    if out.exists():
        raise ValueError('Preserve existing output')
    out.write_text(text)
    return {'upstream_sha256': UPSTREAM_SHA, 'derived_sha256': hashlib.sha256(text.encode()).hexdigest(), 'runtime_changed': False, 'bot_sent': False}

if __name__ == '__main__':
    print(json.dumps(prepare(*sys.argv[1:])))
