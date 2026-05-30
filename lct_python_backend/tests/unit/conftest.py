"""Unit-test event-loop isolation.

Some unit tests run coroutines via ``asyncio.get_event_loop().run_until_complete()``
(reusing a persistent loop); others use ``asyncio.run()`` (which creates + closes its
own loop and clears the current one). Mixed in a single pytest process, an
``asyncio.run()`` test leaves ``get_event_loop()`` without a usable loop, so the older
tests fail depending on collection order.

Give every unit test a fresh current loop so the two styles can't pollute each other,
making the suite order-independent without rewriting every test helper.
"""

import asyncio

import pytest


@pytest.fixture(autouse=True)
def _fresh_event_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        yield
    finally:
        try:
            loop.close()
        finally:
            asyncio.set_event_loop(asyncio.new_event_loop())
