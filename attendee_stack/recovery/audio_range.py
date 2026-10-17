"""Single HTTP byte-range contract for private meeting audio."""
import re


def byte_range(header, size):
    if not isinstance(size, int) or size <= 0:
        raise ValueError("Recording is empty")
    if not header:
        return 0, size - 1, False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
    if not match or not any(match.groups()):
        raise ValueError("Unsupported audio range")
    left, right = match.groups()
    if not left:
        suffix = int(right)
        if suffix <= 0:
            raise ValueError("Invalid suffix range")
        return max(0, size - suffix), size - 1, True
    start = int(left)
    end = min(int(right), size - 1) if right else size - 1
    if start >= size or end < start:
        raise ValueError("Audio range is outside the recording")
    return start, end, True
