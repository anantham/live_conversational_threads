"""Derive presentation routing from exact public Meet payload; no runtime action.

A presentation device is deliberately absent from the human roster. Route its
captions/audio through Google's explicit parent link, as video already does.
No name-based guessing or default participant. Retain original source in the
caption namespace so simultaneous microphone/presentation revisions cannot merge.
"""
import hashlib
import json
from pathlib import Path
import sys

UPSTREAM_SHA = '18d1d59242bbe7089b157e008a1cd343aa40b590c29f1cd932b928f9f4934d50'


def prepare(source, destination):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != UPSTREAM_SHA:
        raise ValueError('Pinned public Meet payload differs; preserve and inspect it')
    text = raw.decode('utf-8')
    old = """    getUserByDeviceId(deviceId) {
        return this.allUsersMap.get(deviceId);
    }
"""
    new = old + """
    getParticipantIdForDevice(deviceId) {
        // Google gives a presentation its own device, tied to its presenter.
        // Roster events exclude those devices; never guess by name or headcount.
        return this.allUsersMap.get(deviceId)?.parentDeviceId || deviceId;
    }
"""
    if text.count(old) != 1:
        raise ValueError('Participant lookup insertion differs')
    text = text.replace(old, new)
    old = """    this.sendJson({
        type: 'CaptionUpdate',
        caption: item
    });
"""
    new = """    const participantId = userManager.getParticipantIdForDevice(item.deviceId);
    const caption = participantId === item.deviceId ? item : {
        ...item,
        deviceId: participantId,
        // Python accepts string IDs; preserve the original device in the key.
        captionId: 'presentation:' + JSON.stringify([item.deviceId, String(item.captionId)])
    };
    this.sendJson({
        type: 'CaptionUpdate',
        caption
    });
"""
    if text.count(old) != 1:
        raise ValueError('Caption forwarding point differs')
    text = text.replace(old, new)
    old = 'const participantIdBytes = new TextEncoder().encode(participantId);'
    # Both audio and video have this line. Change audio only; video already uses
    # the parent participant before reaching its transport method.
    start = text.index('  sendPerParticipantAudio(participantId, audioData) {')
    end = text.index('  sendPerParticipantVideo(', start)
    audio = text[start:end]
    if audio.count(old) != 1:
        raise ValueError('Audio forwarding point differs')
    audio = audio.replace(old, 'const participantIdBytes = new TextEncoder().encode(userManager.getParticipantIdForDevice(participantId));')
    text = text[:start] + audio + text[end:]
    output = Path(destination)
    if output.exists():
        raise ValueError('Preserve existing output')
    output.write_text(text)
    return {'upstream_sha256': UPSTREAM_SHA, 'derived_sha256': hashlib.sha256(text.encode()).hexdigest(),
            'source_lines_before': len(raw.splitlines()), 'source_lines_after': len(text.splitlines()),
            'runtime_changed': False, 'bot_sent': False}


if __name__ == '__main__':
    print(json.dumps(prepare(*sys.argv[1:])))
