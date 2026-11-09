"""Test intent: scoped live audio parts encode real playable mono WAV and bound bytes/rates.
No database, server, network or private recording is touched.
"""
import io
import struct
import unittest
import wave
from audio_chunks import pcm_wave, MAX_PCM_BYTES

class LiveAudioTests(unittest.TestCase):
    def test_real_pcm_header_and_audio_round_trip(self):
        pcm = b"".join(struct.pack("<h", sample) for sample in (0, 1234, -1234, 32767, -32768))
        encoded = pcm_wave(pcm, 48000)
        with wave.open(io.BytesIO(encoded), "rb") as reader:
            self.assertEqual((reader.getnchannels(), reader.getsampwidth(), reader.getframerate(), reader.getnframes()), (1, 2, 48000, 5))
            self.assertEqual(reader.readframes(5), pcm)

    def test_invalid_and_excess_audio_refuses(self):
        for data, rate in [(b"", 48000), (b"x", 48000), (b"xx", 1), (bytes(MAX_PCM_BYTES + 2), 48000)]:
            with self.assertRaises(ValueError):
                pcm_wave(data, rate)

if __name__ == '__main__':
    unittest.main()
