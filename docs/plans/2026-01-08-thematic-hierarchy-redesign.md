# Thematic Hierarchy Redesign

**Date:** 2026-01-08
**Status:** Approved

## Problem

The current thematic analysis has architectural issues:
1. **Two disconnected trees**: L2→L1 and L5→L4→L3 are generated independently
2. **L2 duplicates**: Regeneration doesn't clean up old nodes, causing accumulation
3. **No utterance-level view**: Users can't see the raw transcript in the graph
4. **No configurable granularity**: Hard-coded clustering parameters
5. **UI issues**: Text overflow, tiny nodes, invisible edges

## Solution: Single Bottom-Up Hierarchy

### New Structure

```
Level 0: Utterances (raw transcript) - ground truth
    ↓ cluster ~5 utterances each (configurable)
Level 5: Atomic themes - individual discussion points
    ↓ cluster ~2-3 each (configurable)
Level 4: Fine themes - related points grouped
    ↓ cluster ~2-3 each
Level 3: Medium themes - thematic threads
    ↓ cluster ~2-3 each
Level 2: Themes - major topics
    ↓ cluster ~2-3 each
Level 1: Mega-themes - the big picture
```

### Generation Flow

1. User opens conversation → sees utterances immediately (Level 0)
2. Clicks "Generate Themes" → backend starts L5 generation
3. Progress indicator shows current level being generated
4. As each level completes, it becomes available in level selector
5. Each level clusters its child level (true zoom semantics)

## API Changes

### POST /api/conversations/{id}/themes/generate

```json
{
  "model": "anthropic/claude-3.5-sonnet",
  "utterances_per_atomic_theme": 5,
  "clustering_ratio": 2.5,
  "force_regenerate": true
}
```

**Behavior:**
- If `force_regenerate=true`, delete all existing nodes (level > 0) first
- Generate L5 from utterances using `utterances_per_atomic_theme`
- Cluster upward: L5 → L4 → L3 → L2 → L1
- Each clustering step uses `clustering_ratio` to determine target count

## Settings Panel

### Display Settings
- Font size: 10px - 20px (default: 14px)
- Node min-width: 150px - 400px (default: 200px)
- Show node summaries: on/off

### Granularity Settings
- Utterances per atomic theme: 3 - 10 (default: 5)
- Clustering ratio: 2 - 4 (default: 2.5)

### Edge Settings
- Show edges: on/off
- Edge thickness: 1px - 4px (default: 2px)
- Colors by type:
  - temporal: blue
  - topical: green
  - causal: orange
  - tangent: purple

### Model Settings
- Model dropdown: Claude 3.5 Sonnet, Claude 3 Haiku, GPT-4o, etc. (via OpenRouter)

## UI Components

### Level Selector
```
◀ Less  [U] [5] [4] [3] [2] [1]  More ▶
         368  75  35  15   7   3
```
- "U" = Utterances (Level 0)
- Numbers show node count per level
- Grayed out = not yet generated
- Pulsing dot = currently generating

### Progress Indicator
```
● Generating Level 5 (atomic themes)...  2/5
○ Level 4  ○ Level 3  ○ Level 2  ○ Level 1
```

### Node Card
- Min-width from settings
- Text wraps, truncates after 3 lines
- Expand on click
- Timestamp range shown subtly

### Edge Legend
Bottom-left, near zoom controls:
```
─── temporal (blue)
─── topical (green)
─── causal (orange)
─── tangent (purple)
```

## Implementation Phases

### Phase 1: Backend Foundation
1. Add node cleanup before regeneration
2. Refactor to single tree (L5 → L4 → L3 → L2 → L1)
3. Add configurable parameters to API
4. Update L5 prompt to use utterances_per_atomic_theme

### Phase 2: Frontend Core
5. Add Settings panel with localStorage
6. Add Utterances as Level 0 in selector
7. Fix node text overflow and sizing
8. Pass settings to backend on regeneration

### Phase 3: Polish
9. Add progress indicators
10. Implement color-coded edges with legend
11. Add frontend logging

## Files to Modify

**Backend:**
- `backend.py` - API endpoint changes, cleanup logic
- `services/thematic_analyzer.py` - Remove or repurpose
- `services/hierarchical_themes/level_5_clusterer.py` - Use granularity param
- `services/hierarchical_themes/level_*.py` - Use clustering_ratio
- `services/hierarchical_themes/base_clusterer.py` - Add cleanup method

**Frontend:**
- `components/ThematicView.jsx` - Level selector, node styling
- `components/SettingsPanel.jsx` - New component
- `services/api.js` - Pass new parameters
