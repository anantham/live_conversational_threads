"""Host-owned runtime handoff to HTTP and WebSocket entry points.

No request/config parsing, inference, dependency installation or activation.
The serving host installs one verified configuration on application state.
Absent configuration retains legacy behavior; invalid configuration fails closed.
Stored conversation ownership and consent are still checked by every stage.
"""
from .interleaved_runtime import InterleavedRuntimeConfig


def runtime_for_connection(connection):
    if connection is None:
        return None
    runtime = getattr(connection.app.state, 'interleaved_runtime', None)
    if runtime is not None and not isinstance(runtime, InterleavedRuntimeConfig):
        raise RuntimeError('Host interleaved runtime is not a verified runtime configuration')
    return runtime
