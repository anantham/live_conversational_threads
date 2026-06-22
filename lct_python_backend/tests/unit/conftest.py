"""Unit-test shared setup and event-loop isolation.

Optional-dependency stubs install at import time so collection succeeds on
machines without every production dependency. Per-test event-loop isolation
keeps ``asyncio.run()`` and ``run_until_complete()`` styles order-independent.
"""

import asyncio
import sys
import types

import pytest

try:
    from google.cloud import storage as _gcs_storage  # noqa: F401
except ImportError:
    google_module = sys.modules.get("google")
    if google_module is None:
        google_module = types.ModuleType("google")
        sys.modules["google"] = google_module

    cloud_module = types.ModuleType("google.cloud")
    storage_module = types.ModuleType("google.cloud.storage")

    class _UnavailableStorageClient:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("google-cloud-storage test stub should not be used at runtime")

        def bucket(self, *_args, **_kwargs):
            raise RuntimeError("google-cloud-storage test stub should not be used at runtime")

    class _UnavailableBlob:
        def exists(self):
            return False

        def delete(self):
            raise RuntimeError("google-cloud-storage test stub should not be used at runtime")

        def upload_from_string(self, *_args, **_kwargs):
            raise RuntimeError("google-cloud-storage test stub should not be used at runtime")

    storage_module.Client = _UnavailableStorageClient
    storage_module.Blob = _UnavailableBlob
    cloud_module.storage = storage_module
    setattr(google_module, "cloud", cloud_module)
    sys.modules["google.cloud"] = cloud_module
    sys.modules["google.cloud.storage"] = storage_module


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