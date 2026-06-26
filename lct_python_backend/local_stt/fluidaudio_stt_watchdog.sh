#!/bin/bash
# Watchdog for FluidAudio STT — started by launchd (Aqua session only).
# The binary needs a live GUI/Aqua session to init CoreML/ANE; running the
# binary directly under launchd hangs. This script spawns it as a detached
# child of the user shell, which gets the session, then loops to revive it.
set -euo pipefail

BINARY_DIR="$HOME/Documents/Ongoing Local/live_conversational_threads/lct_python_backend/local_stt/fluidaudio_stt"
BINARY="$BINARY_DIR/.build/release/fluidaudio-stt"
LOG="/tmp/fa-stt.log"
WATCH_LOG="/tmp/fa-watch.log"

_start() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): starting FluidAudio" >> "$WATCH_LOG"
    # Detach from launchd's process group so the child owns its own session.
    # env -i gives it a clean environment that matches the nohup manual launch.
    (
      cd "$BINARY_DIR"
      env -i \
        HOME="$HOME" USER="$USER" LOGNAME="$USER" \
        TMPDIR="$TMPDIR" \
        PATH="/opt/homebrew/bin:/usr/bin:/bin" \
        nohup "$BINARY" >> "$LOG" 2>&1 &
      echo $! >> "$WATCH_LOG"
    )
}

# Give the user session (WindowServer, ANE) time to fully init after login.
sleep 15

# Start immediately if not already running.
pgrep -f "fluidaudio-stt" > /dev/null || _start

# Then keep watch every 60 s.
while true; do
    sleep 60
    if ! pgrep -f "fluidaudio-stt" > /dev/null; then
        echo "$(date '+%Y-%m-%d %H:%M:%S'): FluidAudio not found, restarting" >> "$WATCH_LOG"
        _start
    fi
done
