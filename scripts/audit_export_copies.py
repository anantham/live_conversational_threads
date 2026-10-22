"""Inspect only task-named export copies; never infer failure from an event timeout.

A matching file proves its current bytes and timestamp, not its download origin.
No file, browser, credential, network or application state is changed.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re


def audit(directory, expected_name, expected_sha256, since):
    if Path(expected_name).name != expected_name or not Path(expected_name).suffix:
        raise ValueError('Provide one exact export filename, without a path')
    if not re.fullmatch('[0-9a-f]{64}', expected_sha256) or not math.isfinite(since):
        raise ValueError('Provide a SHA256 and finite observation-window start')
    name = Path(expected_name)
    pattern = re.compile(re.escape(name.stem) + r'(?: \([1-9][0-9]*\))?' + re.escape(name.suffix))
    receipts = []
    for candidate in sorted(Path(directory).iterdir()):
        if not pattern.fullmatch(candidate.name):
            continue
        if candidate.is_symlink():
            receipts.append({'name': candidate.name, 'state': 'linked_unverified'})
            continue
        if not candidate.is_file():
            continue
        stat = candidate.stat()
        state = 'older_copy' if stat.st_mtime < since else (
            'verified' if hashlib.sha256(candidate.read_bytes()).hexdigest() == expected_sha256 else 'mismatch')
        receipts.append({'name': candidate.name, 'bytes': stat.st_size, 'modified': stat.st_mtime, 'state': state})
    states = {item['state'] for item in receipts}
    status = 'unverified' if states & {'linked_unverified', 'mismatch'} else 'verified' if 'verified' in states else 'not_observed'
    return {'status': status, 'since': since, 'copies': receipts, 'download_origin_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory'); parser.add_argument('expected_name')
    parser.add_argument('--sha256', required=True); parser.add_argument('--since', required=True, type=float)
    args = parser.parse_args()
    print(json.dumps(audit(args.directory, args.expected_name, args.sha256, args.since)))
