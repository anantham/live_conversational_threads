# Viewer timeline continuity test intent

- A moment with a home lane and secondary `thread_ids` appears once in each authored lane, in time order; legacy `thread_id` only and unassigned moments keep their existing lanes.
- Lane navigation and the reading path include every unique moment in the chosen thread. A duplicate lane rendering must not add a false transition to the chronological path.
- The header reports authored thread and unassigned lane counts separately. A 15-lane timeline exposes expansion and keeps the final lane in the shared vertical scroll area with a full-height plot.
- Resizing and collapsing remain keyboard-accessible; expansion stays within a viewport-relative cap so the graph remains usable on desktop and phone.
