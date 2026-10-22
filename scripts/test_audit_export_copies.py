"""Test intent: verify numbered exports, bytes/window, incomplete and linked refusal.

All state uses a fresh synthetic temporary directory; no Downloads or app import.
An observer timeout/no observed artifact is never classified as a failed download.
"""
import hashlib
import os
from pathlib import Path
import tempfile
import time
import unittest

from audit_export_copies import audit


class ExportCopiesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lct-export-receipts-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = b'synthetic export'
        self.sha = hashlib.sha256(self.payload).hexdigest()
        self.since = time.time() - 60

    def test_numbered_audio_and_transcript_names_are_verified(self):
        for name, copy in [('recording.mp3', 'recording (2).mp3'), ('recording.transcript.json', 'recording.transcript (12).json')]:
            (self.root / copy).write_bytes(self.payload)
            result = audit(self.root, name, self.sha, self.since)
            self.assertEqual(result['status'], 'verified')
            self.assertEqual([x['name'] for x in result['copies']], [copy])
            self.assertFalse(result['download_origin_verified'])

    def test_older_copy_does_not_prove_a_new_export(self):
        old = self.root / 'recording.mp3'; old.write_bytes(self.payload)
        os.utime(old, (1, 1))
        self.assertEqual(audit(self.root, old.name, self.sha, self.since)['status'], 'not_observed')

    def test_mismatched_new_copy_is_not_hidden_by_a_valid_one(self):
        (self.root / 'recording.mp3').write_bytes(self.payload)
        wrong = self.root / 'recording (2).mp3'; wrong.write_bytes(b'wrong bytes')
        self.assertEqual(audit(self.root, 'recording.mp3', self.sha, self.since)['status'], 'unverified')
        self.assertEqual(wrong.read_bytes(), b'wrong bytes')

    def test_partial_and_unrelated_names_do_not_count_as_completed(self):
        for name in ['recording.mp3.crdownload', 'recording (2).wav', 'unrelated.mp3']:
            (self.root / name).write_bytes(self.payload)
        result = audit(self.root, 'recording.mp3', self.sha, self.since)
        self.assertEqual(result['status'], 'not_observed'); self.assertEqual(result['copies'], [])

    def test_matching_link_is_not_followed(self):
        target = self.root / 'untouched'; target.write_bytes(self.payload)
        (self.root / 'recording.mp3').symlink_to(target)
        self.assertEqual(audit(self.root, 'recording.mp3', self.sha, self.since)['status'], 'unverified')
        self.assertEqual(target.read_bytes(), self.payload)

    def test_invalid_identity_or_window_refuses(self):
        for name, sha, since in [('../recording.mp3', self.sha, self.since), ('recording.mp3', 'bad', self.since), ('recording.mp3', self.sha, float('nan'))]:
            with self.assertRaises(ValueError): audit(self.root, name, sha, since)


if __name__ == '__main__':
    unittest.main()
