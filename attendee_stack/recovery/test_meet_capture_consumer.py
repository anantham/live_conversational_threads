"""Test intent: actual public caption/audio managers consume emitted synthetic wire.

Require dedicated persistence identity before imports; no Django/DB/network or
provider usage. Assert observable caption saves, distinct source keys, PCM chunk
callback data and valid five-second WAV. Unknown identities still cannot save.
RMS quarter/full scale must be finite and accurate: int16 squaring overflows.
Run in the existing recovery app with its real numpy/webrtcvad dependencies.
"""
import base64
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import struct
import sys
from datetime import datetime
import unittest
import wave
if os.environ.get('POSTGRES_DB') != 'lct_meet_recovery_20261017':
    raise RuntimeError('Wrong persistence root; no imports or action')
import numpy as np

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

cc = load('lct_synthetic_caption_manager', sys.argv[1])
audio = load('lct_synthetic_audio_manager', sys.argv[2])
fixture = json.loads(Path(sys.argv[3]).read_text())
sys.argv = sys.argv[:1]
packets = [base64.b64decode(p, validate=True) for p in fixture['packets']]
messages = [json.loads(p[4:]) for p in packets if struct.unpack('<i', p[:4])[0] == 1]
roster = next(m['newUsers'] for m in messages if m['type'] == 'UsersUpdate')
participants = {u['deviceId']: {'participant_uuid': u['deviceId'], 'participant_full_name': u['fullName'],
    'participant_user_uuid': None, 'participant_is_the_bot': bool(u['isCurrentUser']), 'participant_is_host': bool(u['isHost'])} for u in roster}
captions = [m['caption'] for m in messages if m['type'] == 'CaptionUpdate']
wire = next(p for p in packets if struct.unpack('<i', p[:4])[0] == 5)
n = wire[4]; speaker = wire[5:5+n].decode(); floats = np.frombuffer(wire[5+n:], dtype=np.float32)
pcm = (floats * 32768.0).astype(np.int16).tobytes()
assert len(roster)==3 and len(captions)==3 and len(floats)==80000

class CaptureConsumerTests(unittest.TestCase):
    def manager(self, saved):
        return audio.PerParticipantNonStreamingAudioInputManager(save_audio_chunk_callback=saved.append,
            get_participant_callback=participants.get, sample_rate=16000, utterance_size_limit=160000,
            silence_duration_limit=3, should_print_diagnostic_info=False)

    def test_captions_persist_three_distinct_sources_under_explicit_presenter(self):
        saved=[]; m=cc.ClosedCaptionManager(save_utterance_callback=saved.append, get_participant_callback=participants.get)
        for caption in captions: m.upsert_caption(caption)
        m.process_captions()
        self.assertEqual(len(saved),3)
        self.assertEqual({s['participant_uuid'] for s in saved},{'host-a'})
        self.assertEqual(len({s['source_uuid_suffix'] for s in saved}),3)
        self.assertTrue(all(s['text']=='Synthetic garden planning' for s in saved))

    def test_unknown_caption_still_cannot_persist(self):
        saved=[]; m=cc.ClosedCaptionManager(save_utterance_callback=saved.append, get_participant_callback=participants.get)
        m.upsert_caption({'captionId':7,'deviceId':'unknown','isFinal':1,'text':'Synthetic unknown'})
        m.process_captions(); m.flush_captions(); self.assertEqual(saved,[])

    def test_presentation_pcm_emits_actual_five_second_chunk(self):
        saved=[]; m=self.manager(saved); m.add_chunk(speaker, datetime.utcnow(), pcm); m.process_chunks()
        self.assertEqual(len(saved),1); self.assertEqual(saved[0]['participant_uuid'],'host-a')
        self.assertEqual(saved[0]['audio_data'],pcm); self.assertEqual(saved[0]['sample_rate'],16000)

    def test_saved_chunk_is_valid_five_second_wav(self):
        from lct_audio_chunks import pcm_wave
        saved=[]; m=self.manager(saved); m.add_chunk(speaker,datetime.utcnow(),pcm); m.process_chunks()
        self.assertEqual(len(saved),1)
        with wave.open(io.BytesIO(pcm_wave(saved[0]['audio_data'],saved[0]['sample_rate'])),'rb') as r:
            self.assertEqual((r.getnchannels(),r.getsampwidth(),r.getframerate(),r.getnframes()),(1,2,16000,80000))

    def test_unknown_pcm_identity_still_cannot_persist(self):
        saved=[]; m=self.manager(saved); m.add_chunk('unknown',datetime.utcnow(),pcm); m.process_chunks(); self.assertEqual(saved,[])

    def test_rms_quarter_scale_positive_is_accurate(self):
        self.assertAlmostEqual(audio.calculate_normalized_rms(np.full(160,8192,dtype=np.int16).tobytes()),0.25,places=6)

    def test_rms_quarter_scale_negative_is_accurate(self):
        self.assertAlmostEqual(audio.calculate_normalized_rms(np.full(160,-8192,dtype=np.int16).tobytes()),0.25,places=6)

    def test_rms_full_scale_is_finite(self):
        value=audio.calculate_normalized_rms(np.full(160,32767,dtype=np.int16).tobytes())
        self.assertTrue(math.isfinite(value)); self.assertAlmostEqual(value,32767/32768,places=6)

if __name__=='__main__': unittest.main()
