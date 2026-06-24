"""Picker contact curation (#4): dedup auto-formed duplicate identities + rank by
signal so real conversational contacts surface and auto-ingested noise sinks.

The real human-reviewed-vs-auto distinction is IndrasNet-side (#14); this guards
the LCT-side proxy ranking.
"""
from lct_python_backend.consumption_prayer_api import (
    _curate_picker_contacts,
    _looks_like_phone_name,
)


def test_looks_like_phone_name():
    assert _looks_like_phone_name("+918035273596")
    assert _looks_like_phone_name("+91 (803) 527-3596")
    assert not _looks_like_phone_name("Vatsal")
    assert not _looks_like_phone_name("+91 80619 Amazon Delivery")  # has text -> named
    assert not _looks_like_phone_name("")


def test_curate_dedups_and_ranks_by_signal():
    contacts = [
        {"display_name": "aditya", "item_count": 2102, "last_activity": "2026-06-23"},
        {"display_name": "Aditya", "item_count": 2201, "last_activity": "2026-06-22"},
        {"display_name": "+918035273596", "item_count": 2, "last_activity": "2023-03-22"},
        {"display_name": "Vatsal", "item_count": 7368, "last_activity": "2026-06-24"},
        {"display_name": "Vishnu GT", "item_count": 2, "last_activity": "2026-06-01"},
        {"display_name": "Vishnu GT", "item_count": 13, "last_activity": "2026-06-05"},
    ]
    out = _curate_picker_contacts(contacts)
    names = [c["display_name"] for c in out]
    # dedup by normalized name (aditya/Aditya, Vishnu GT x2)
    assert len(out) == 4
    # highest-signal real contact first; the bare phone number sinks to the bottom
    assert names[0] == "Vatsal"
    assert names[-1] == "+918035273596"
    # the kept duplicate is the higher-item_count record
    aditya = next(c for c in out if c["display_name"].lower() == "aditya")
    assert aditya["item_count"] == 2201


def test_curate_handles_garbage_input():
    assert _curate_picker_contacts(None) == []
    assert _curate_picker_contacts([]) == []
    assert _curate_picker_contacts([{"item_count": 5}, "nope", {"display_name": ""}]) == []
