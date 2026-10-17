"""Range behavior for private audio; no server, storage or live recordings."""
import unittest
from audio_range import byte_range


class AudioRangeTests(unittest.TestCase):
    def test_playback_and_seek_ranges(self):
        for header, expected in [(None, (0, 99, False)), ('bytes=0-9', (0, 9, True)),
                                 ('bytes=90-', (90, 99, True)), ('bytes=-10', (90, 99, True)),
                                 ('bytes=90-999', (90, 99, True)), ('bytes=-999', (0, 99, True))]:
            self.assertEqual(byte_range(header, 100), expected)

    def test_invalid_ranges_refuse_instead_of_reading_other_bytes(self):
        for header in ['bytes=100-', 'bytes=-0', 'bytes=9-1', 'bytes=-', 'bytes=0-1,4-5',
                       'garbage', 'bytes=0-9\r\nother: header']:
            with self.assertRaises(ValueError):
                byte_range(header, 100)
        with self.assertRaises(ValueError):
            byte_range(None, 0)


if __name__ == '__main__':
    unittest.main()
