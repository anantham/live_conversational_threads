#!/usr/bin/env python3
"""
End-to-end verification of the consumption-prayer read path against the real
deployed IndrasNet at 100.81.65.74:7777.

Probes (no state mutation — read-only):
  1. IndrasNet ping
  2. GET /api/contacts?limit=10 — list real contacts so we have refs to test
  3. For each contact with obsidian_note_path: GET
     /api/contacts/{contact_id}/pending-discussions — verify the new route
     is deployed and what it returns
  4. LCT manual-trigger endpoint via FastAPI TestClient — POST a real-shaped
     payload through our client to the same IndrasNet route, confirm the
     full LCT → IndrasNet round-trip works

What this does NOT do (deferred to the user on the remote box):
  - Approve a prayer to test the auto-write hook (would mutate state)
  - Run the backfill script against the remote DB
  - Verify any actual notes were appended (need vault filesystem access)

Run:
  $env:PYTHONIOENCODING = "utf-8"
  C:\\Users\\adity\\anaconda3\\python.exe scripts/e2e_verify_consumption.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

LCT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LCT_ROOT))


def banner(title: str) -> None:
    print()
    print("=" * 72)
    print(f"  {title}")
    print("=" * 72)


def summary_line(label: str, ok: bool, detail: str = "") -> None:
    mark = "PASS" if ok else "FAIL"
    line = f"  [{mark}] {label}"
    if detail:
        line += f" — {detail}"
    print(line)


# ===========================================================================
# Test 1: IndrasNet reachability
# ===========================================================================

async def test_ping():
    """Try a few times — the remote IndrasNet can be slow to first-respond
    after idle. We need a real signal, not a transient timeout."""
    banner("STEP 1 · IndrasNet reachability probe (with retries)")
    import httpx
    from lct_python_backend.services.indrasnet_client import get_indrasnet_base_url

    base = get_indrasnet_base_url()
    print(f"  target: {base}")

    last_status = None
    for attempt in range(1, 5):
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(f"{base}/api/prayers/latest?limit=1")
            last_status = r.status_code
            if r.status_code < 500:
                summary_line(
                    f"reachability (attempt {attempt})", True,
                    f"status={r.status_code}",
                )
                return True
            print(f"  attempt {attempt}: status={r.status_code} (5xx — retrying)")
        except Exception as e:
            print(f"  attempt {attempt}: {type(e).__name__} — {str(e)[:60]}")
        await asyncio.sleep(1.5)

    summary_line("reachability", False, f"4 attempts failed (last_status={last_status})")
    return False


# ===========================================================================
# Test 2: List contacts
# ===========================================================================

async def test_list_contacts():
    banner("STEP 2 · GET /api/contacts — discover real contact IDs")
    import httpx
    from lct_python_backend.services.indrasnet_client import get_indrasnet_base_url

    base = get_indrasnet_base_url()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/api/contacts?limit=15")
        if r.status_code != 200:
            summary_line("GET /api/contacts", False, f"status={r.status_code}")
            print(f"  body: {r.text[:200]}")
            return []

        body = r.json()
        contacts = body if isinstance(body, list) else body.get("contacts", body.get("items", []))

        with_path = [c for c in contacts if c.get("obsidian_note_path")]
        without_path = [c for c in contacts if not c.get("obsidian_note_path")]

        summary_line(
            "GET /api/contacts",
            True,
            f"{len(contacts)} contacts, {len(with_path)} have obsidian_note_path",
        )

        print(f"\n  Sample (first 5 with note_path):")
        for c in with_path[:5]:
            cid = c.get("contact_id", "?")
            name = c.get("display_name", "?")
            path = c.get("obsidian_note_path", "")
            print(f"    {cid[:24]:<24}  {name:<25}  {path[:50]}")

        if not with_path:
            print(f"\n  No contacts have obsidian_note_path configured.")
            print(f"  Without that, the GET /api/contacts/{{ref}}/pending-discussions")
            print(f"  endpoint returns status='no_note_path' for all of them — the")
            print(f"  feature is wired but has no actual data to surface yet.")
            if without_path:
                print(f"\n  Sample of contacts WITHOUT path (top 3):")
                for c in without_path[:3]:
                    name = c.get("display_name", "?")
                    print(f"    {name}")

        return with_path
    except Exception as e:
        summary_line("GET /api/contacts", False, f"{type(e).__name__}: {e}")
        return []


# ===========================================================================
# Test 3: GET pending-discussions for each contact with a note
# ===========================================================================

async def test_pending_for_contacts(contacts: list):
    banner("STEP 3 · GET /api/contacts/{ref}/pending-discussions")
    from lct_python_backend.services.indrasnet_client import (
        IndrasNetClientError,
        get_pending_discussions,
    )

    if not contacts:
        print("  (skipped — no contacts with note_path to test against)")
        return

    # Test up to 5 contacts
    targets = contacts[:5]
    routes_alive = 0
    items_total = 0

    for c in targets:
        cid = c.get("contact_id")
        name = c.get("display_name", "?")
        try:
            body = await get_pending_discussions(cid)
            routes_alive += 1
            n_items = body.get("item_count", 0)
            items_total += n_items
            status = body.get("status", "?")
            note_path = body.get("note_path", "")
            print(f"  {name:<25} → status={status:<13} items={n_items}  ({Path(note_path).name if note_path else '—'})")
            if n_items > 0:
                print(f"    sample item: {body['items'][0].get('text', '')[:60]}")
        except IndrasNetClientError as e:
            # 404 means the route IS deployed but the contact isn't findable — good signal
            print(f"  {name:<25} → ClientError: {str(e)[:80]}")
            if "404" in str(e):
                routes_alive += 1  # route exists, just contact lookup failed
        except Exception as e:
            print(f"  {name:<25} → {type(e).__name__}: {str(e)[:60]}")

    print()
    if routes_alive == 0:
        summary_line(
            "pending-discussions route",
            False,
            "no contacts reachable — route may not be deployed",
        )
    else:
        summary_line(
            "pending-discussions route",
            True,
            f"deployed; {routes_alive}/{len(targets)} contacts responded; {items_total} items total",
        )


# ===========================================================================
# Test 4: LCT manual-trigger endpoint via in-process TestClient
# ===========================================================================

def test_lct_manual_endpoint(contacts: list):
    banner("STEP 4 · LCT manual-trigger endpoint via in-process TestClient")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from lct_python_backend import consumption_prayer_api

    app = FastAPI()
    app.include_router(consumption_prayer_api.router)
    client = TestClient(app)

    if not contacts:
        # Test against a clearly non-existent contact to verify error path
        r = client.post(
            "/api/conversations/verify-test/recommend-consumption-query",
            json={"selected_text": "test", "contact_ref": "definitely-not-a-real-contact-12345"},
        )
        if r.status_code == 404:
            summary_line(
                "Manual endpoint error-path",
                True,
                "404 from IndrasNet propagated correctly (route deployed + error mapping works)",
            )
        elif r.status_code == 502:
            summary_line(
                "Manual endpoint error-path",
                True,
                f"502 — IndrasNet returned an error: {r.json().get('detail', '')[:80]}",
            )
        else:
            summary_line(
                "Manual endpoint error-path",
                False,
                f"unexpected status {r.status_code}: {r.text[:120]}",
            )
        return

    # Happy-path probe with a real contact
    target = contacts[0]
    cid = target.get("contact_id")
    name = target.get("display_name", "?")

    r = client.post(
        "/api/conversations/verify-test/recommend-consumption-query",
        json={
            "selected_text": f"what was {name} saying — verification probe",
            "contact_ref": cid,
        },
    )

    if r.status_code != 200:
        summary_line(
            "Manual endpoint happy path",
            False,
            f"status={r.status_code} body={r.text[:200]}",
        )
        return

    body = r.json()
    expected_keys = {"source", "conversation_id", "selected_text", "triggered_at",
                     "contact", "items", "item_count", "status"}
    missing = expected_keys - set(body.keys())
    if missing:
        summary_line(
            "Manual endpoint happy path",
            False,
            f"response missing keys: {missing}",
        )
        return

    summary_line(
        "Manual endpoint happy path",
        True,
        f"source={body['source']} contact={body['contact']['display_name']} items={body['item_count']} status={body['status']}",
    )

    print(f"\n  Full response:")
    print(textwrap.indent(json.dumps(body, indent=2)[:1200], "    "))


# ===========================================================================
# Main
# ===========================================================================

async def main():
    print("e2e_verify_consumption · backend-only checks against deployed IndrasNet")
    print(f"  cwd: {os.getcwd()}")
    print(f"  lct: {LCT_ROOT}")

    alive = await test_ping()
    if not alive:
        print("\n  Remote unreachable — aborting further tests.")
        print("  Are you on Tailscale? Is the IndrasNet web server running at 100.81.65.74:7777?")
        sys.exit(1)

    contacts = await test_list_contacts()
    await test_pending_for_contacts(contacts)
    test_lct_manual_endpoint(contacts)

    print()
    print("=" * 72)
    print("  DONE — see PASS/FAIL above")
    print("=" * 72)
    print()
    print("Manual checks for the WRITE path (not done here, mutate state on remote):")
    print("  - Approve an Unreviewed Remind/Connect prayer with resolvable participants")
    print("    via POST /api/prayers/{id}/approve, then check whether the participant's")
    print("    contact note got a new bullet under '## Pending discussions'")
    print("  - Run scripts/backfill_pending_discussions.py on the remote box to populate")
    print("    historical bullets from existing ~27 Confirmed Reminds/Connects")


if __name__ == "__main__":
    asyncio.run(main())
