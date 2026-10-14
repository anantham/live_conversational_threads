# Viewer reliability repair test intent

- Restore Back and Forward to a visible selected card when the saved camera leaves it outside the usable canvas; preserve the exact saved camera when the card is already visible after a manual pan.
- Escape closes an open node detail when focus remains on a navigation tooltip, while Escape still dismisses the tooltip itself.
- Rapid Source close and reopen must cancel or retire the old YouTube player without app-origin warnings or stale callbacks; the SDK fixture proves lifecycle wiring, and real playback remains a separate check.
