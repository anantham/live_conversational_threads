"""Inspect bounded public source tar on stdin; no extraction or task execution."""
import argparse
import hashlib
import io
import json
import sys
import tarfile

EXPECTED = {'original': '7c264ffa44726ded798bb2c5f8382572e1b1c2e08a6dc75a26d2710fde6e9254', 'candidate': 'f9d671d4e5f913c2333d16b06a4b01bb0d7a305202709bab7d52f0fad00003b6'}

def inspect_archive(raw, expected="either"):
    if not raw or len(raw) > 65536:
        raise ValueError("Archive missing or larger than bound")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        members = archive.getmembers()
        if len(members) != 1:
            raise ValueError("Exactly one public source member required")
        member = members[0]
        if (not member.isfile() or member.name != "run_bot_task.py"
                or member.uid != 1000 or member.gid != 1000
                or member.mode != 0o755 or not 0 < member.size < 32768):
            raise ValueError("Source identity, type, owner or mode differs")
        data = archive.extractfile(member).read()
    digest = hashlib.sha256(data).hexdigest()
    kinds = [key for key, value in EXPECTED.items() if value == digest]
    if len(kinds) != 1 or expected not in ("either", kinds[0]):
        raise ValueError("Unexpected source bytes; preserve and reconcile")
    compile(data, "run_bot_task.py", "exec")
    return {"kind": kinds[0], "sha256": digest, "uid": member.uid,
            "gid": member.gid, "mode": member.mode, "read_only": True}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect", choices=["either", "original", "candidate"], default="either")
    args = parser.parse_args()
    print(json.dumps(inspect_archive(sys.stdin.buffer.read(65537), args.expect)))
