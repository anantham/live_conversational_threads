# Hierarchical Zoom System Design
**Date:** 2025-01-20
**Status:** Approved
**Scope:** Thematic View Levels 1-5

## Overview

Add 5-level hierarchical zoom to Thematic View, allowing users to zoom in/out to see conversation structure at different granularities. Progressive generation ensures fast initial load (L2) while expensive fine-grained analysis runs in background.

## User Experience

### Initial State
1. User clicks "Generate Thematic View"
2. Level 2 generates synchronously (~30 seconds)
3. Graph displays immediately with 10-15 theme nodes
4. Background job starts generating L5 → L4 → L3 → L1

### Zoom Interaction
- **Zoom out (0.1-0.3)**: See 3-5 mega-themes (L1) - big picture
- **Medium zoom (0.3-0.6)**: See 10-15 themes (L2) - current view
- **Zoom in (0.6-1.0)**: See 20-30 medium themes (L3) - more detail
- **Deep zoom (1.0-1.5)**: See 40-60 fine themes (L4) - fine-grained
- **Max zoom (1.5+)**: See 60-120 atomic themes (L5) - granular detail

### Visual Behavior (Hybrid Mode)
- **Parent nodes**: Shrink to small dots when zoomed past their level
- **Child nodes**: Expand to full size when zoomed to their level
- **Smooth transitions**: CSS animations between states
- **Silent updates**: Zoom buttons enable/disable as levels become available

## Architecture

### Generation Strategy: Bottom-Up Progressive

```
User Request
    ↓
[SYNC] Generate L2 (10-15 themes) ← Return immediately
    ↓
[BACKGROUND TASK]
    ↓
Generate L5 (60-120 atomic themes) ← Most expensive
    ↓ cluster
Generate L4 (40-60 fine themes)
    ↓ cluster
Generate L3 (20-30 medium themes)
    ↓ cluster
Generate L1 (3-5 mega-themes)
    ↓
All levels cached in database
```

**Why bottom-up:**
- Start with finest granularity (L5 = individual utterance clusters)
- Cluster upward into coarser levels
- Natural hierarchy emerges from data
- Each level properly contains children from level below

**Why progressive:**
- Fast time-to-interactive (~30s for L2)
- User explores while background runs (2-5 min)
- No wasted API calls (only generate once)
- Levels become available as they complete

### Service Architecture: Hierarchical Chain

```
lct_python_backend/services/hierarchical_themes/
├── __init__.py
├── base_clusterer.py          # Abstract base class with caching
├── level_5_atomic.py           # Generates 60-120 atomic themes from utterances
├── level_4_clusterer.py        # Clusters L5 → L4 (40-60 nodes)
├── level_3_clusterer.py        # Clusters L4 → L3 (20-30 nodes)
├── level_2_clusterer.py        # Refactored existing ThematicAnalyzer
└── level_1_clusterer.py        # Clusters L2 → L1 (3-5 mega-themes)
```

**Base Class Pattern:**
```python
class BaseClusterer(ABC):
    def __init__(self, db: AsyncSession, model: str, level: int):
        self.db = db
        self.model = model
        self.level = level

    async def get_or_generate(self, conversation_id: str) -> List[Node]:
        """Check cache, generate if missing"""
        existing = await self._load_from_db(conversation_id, self.level)
        if existing:
            return existing

        # Get parent level nodes
        parent_nodes = await self._get_parent_nodes(conversation_id)

        # Generate this level
        return await self.generate_level(conversation_id, parent_nodes)

    @abstractmethod
    async def generate_level(self, conversation_id: str, parent_nodes: List[Node]) -> List[Node]:
        """Generate nodes for this level from parent level"""
        pass
```

### Background Task Controller

```python
async def generate_hierarchical_levels_background(conversation_id: str, utterances: List):
    """Background task that generates L5 → L4 → L3 → L1"""

    # L5: Generate atomic themes (expensive, 2-3 min)
    l5_generator = Level5AtomicGenerator(db, model, level=5)
    l5_nodes = await l5_generator.generate_from_utterances(conversation_id, utterances)

    # L4: Cluster L5 → L4
    l4_clusterer = Level4Clusterer(db, model, level=4)
    l4_nodes = await l4_clusterer.generate_level(conversation_id, l5_nodes)

    # L3: Cluster L4 → L3
    l3_clusterer = Level3Clusterer(db, model, level=3)
    l3_nodes = await l3_clusterer.generate_level(conversation_id, l4_nodes)

    # L1: Cluster L2 → L1 (L2 already exists from sync generation)
    l2_nodes = await Level2Clusterer(db, model, level=2).get_or_generate(conversation_id)
    l1_clusterer = Level1Clusterer(db, model, level=1)
    l1_nodes = await l1_clusterer.generate_level(conversation_id, l2_nodes)
```

## Data Model

### Node Schema Extensions

```python
# Already exists in Node model:
parent_node_id = Column(UUID, ForeignKey('nodes.id'), nullable=True)
children_node_ids = Column(ARRAY(UUID), nullable=True)
level = Column(Integer)  # 1-5 for thematic, 6-9 reserved for linguistic
zoom_level_visible = Column(ARRAY(Integer))  # Which zoom levels show this node

# New field to track generation status:
generation_status = Column(String)  # 'pending', 'generating', 'complete', 'failed'
```

### Parent-Child Relationships

```
L1 Mega-Theme "Discussion about AI Safety"
    ├─ parent_node_id: NULL
    ├─ children_node_ids: [L2_node1, L2_node2, L2_node3]
    └─ level: 1

L2 Theme "Alignment Problem"
    ├─ parent_node_id: L1_node1
    ├─ children_node_ids: [L3_node1, L3_node2]
    └─ level: 2

L3 Medium Theme "Value Learning Challenges"
    ├─ parent_node_id: L2_node1
    ├─ children_node_ids: [L4_node1, L4_node2, L4_node3]
    └─ level: 3

... etc
```

## Frontend Implementation

### Zoom Detection & Level Switching

```javascript
// In ThematicView.jsx
const [currentZoomLevel, setCurrentZoomLevel] = useState(2);
const [availableLevels, setAvailableLevels] = useState([2]);

// Map ReactFlow zoom to detail level
const getDetailLevelFromZoom = (zoom) => {
  if (zoom < 0.3) return 1;      // Mega-themes
  if (zoom < 0.6) return 2;      // Themes (current)
  if (zoom < 1.0) return 3;      // Medium detail
  if (zoom < 1.5) return 4;      // Fine detail
  return 5;                       // Atomic detail
};

// Listen to ReactFlow zoom changes
const onMove = useCallback((event, viewport) => {
  const newLevel = getDetailLevelFromZoom(viewport.zoom);
  if (newLevel !== currentZoomLevel && availableLevels.includes(newLevel)) {
    setCurrentZoomLevel(newLevel);
    // Trigger re-fetch of nodes for new level
    fetchNodesForLevel(newLevel);
  }
}, [currentZoomLevel, availableLevels]);
```

### Node Animation States

```javascript
// Calculate node visual state based on zoom
const getNodeStyle = (node, currentZoom) => {
  const nodeLevel = node.level;
  const zoomLevel = getDetailLevelFromZoom(currentZoom);

  if (zoomLevel < nodeLevel) {
    // We're zoomed out - this node's parent should be visible
    return { display: 'none' };
  } else if (zoomLevel === nodeLevel) {
    // This is the active level - show full node
    return {
      width: 280,
      height: 160,
      opacity: 1,
      transition: 'all 0.3s ease-in-out'
    };
  } else {
    // We're zoomed in past this level - shrink to dot
    return {
      width: 20,
      height: 20,
      opacity: 0.6,
      borderRadius: '50%',
      transition: 'all 0.3s ease-in-out'
    };
  }
};
```

### Polling for Level Availability

```javascript
// Poll backend every 5s to check which levels are ready
useEffect(() => {
  const pollLevels = async () => {
    const res = await fetch(`/api/conversations/${conversationId}/themes/levels`);
    const { available_levels } = await res.json();
    setAvailableLevels(available_levels);
  };

  const interval = setInterval(pollLevels, 5000);
  return () => clearInterval(interval);
}, [conversationId]);
```

## API Endpoints

### New Endpoints

```python
# Get themes for specific level
@lct_app.get("/api/conversations/{conversation_id}/themes")
async def get_themes_for_level(
    conversation_id: str,
    level: Optional[int] = Query(None, ge=1, le=5),
    db: AsyncSession = Depends(get_async_session)
):
    """
    Get thematic nodes for a specific level.
    If level not specified, returns level 2 (default view).
    """
    ...

# Check which levels exist (for polling)
@lct_app.get("/api/conversations/{conversation_id}/themes/levels")
async def get_available_levels(
    conversation_id: str,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Returns which levels have been generated.
    Example: {"available_levels": [2, 3, 5], "generating": [1, 4]}
    """
    ...

# Modified: Kicks off background task
@lct_app.post("/api/conversations/{conversation_id}/themes/generate")
async def generate_thematic_structure(
    conversation_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_async_session)
):
    """
    Generates L2 synchronously, kicks off background task for L5→L4→L3→L1.
    Returns immediately with L2 nodes.
    """
    ...
```

## LLM Prompting Strategy

### Level 5: Atomic Theme Generation
**Goal:** Create 60-120 micro-themes, each covering 3-5 utterances

**Prompt:**
```
Analyze this conversation and identify atomic thematic units - the smallest coherent topics.
Each theme should cover 3-5 consecutive utterances that discuss a single specific point.

For a 400-utterance conversation, generate approximately 80-100 atomic themes.

Each theme should:
- Focus on ONE specific sub-topic or idea
- Include utterances that directly relate to that idea
- Have clear boundaries (where topic shifts)
- Be labeled concisely (3-5 words)
```

### Level 4: Fine Clustering
**Goal:** Cluster 60-120 L5 nodes → 40-60 L4 nodes

**Prompt:**
```
Given these atomic themes, cluster related ones into fine-grained categories.
Merge 2-3 atomic themes that discuss closely related sub-topics.

Input: 80 atomic themes
Output: 40-50 fine themes

Guidelines:
- Each fine theme should contain 2-3 atomic themes
- Only cluster when themes are directly related
- Preserve important distinctions
```

### Level 3, 2, 1: Similar clustering pattern
Each level clusters ~2-3 nodes from the level below.

## Performance Characteristics

### Timing Estimates
- **L2 generation**: 30 seconds (synchronous)
- **L5 generation**: 2-3 minutes (most expensive, many nodes)
- **L4 clustering**: 45 seconds
- **L3 clustering**: 30 seconds
- **L1 clustering**: 20 seconds

**Total background time:** ~4-5 minutes for all levels

### API Cost Estimates
- **L2**: ~$0.10 (current cost)
- **L5**: ~$0.40 (large context, many nodes)
- **L4-L3-L1**: ~$0.20 combined (clustering smaller contexts)

**Total cost per conversation:** ~$0.70 for full hierarchy

### Database Storage
- **Nodes per conversation:** ~200-250 total across all levels
- **Size per node:** ~2KB average
- **Total storage:** ~500KB per analyzed conversation

## Testing Strategy

### Unit Tests
- Each clusterer service independently testable
- Mock parent nodes, verify clustering logic
- Test caching behavior (cache hit/miss)

### Integration Tests
- Full pipeline: utterances → L5 → L4 → L3 → L2 → L1
- Verify parent-child relationships correct
- Test background task execution

### Manual Testing
- Generate hierarchy for test conversation
- Verify zoom transitions smooth
- Check all levels cached correctly
- Test partial generation (interrupt background task)

## Future Extensions

### Linguistic View (Levels 6-9)
**Scope:** Selected theme only, not full conversation

**Architecture:**
```
User selects L2 theme node → Switches to "Linguistic View"
    ↓
System analyzes ONLY that theme's utterances (50-100 sentences)
    ↓
L6: Sentence structures (syntactic analysis)
L7: Word/phrase analysis (lexical units)
L8: Morpheme breakdown (word stems, prefixes, suffixes)
L9: Etymology/phonemes (word origins, sound units)
```

**Benefits:**
- Scoped analysis (cheaper, faster)
- Separate concern (semantic vs structural)
- Progressive enhancement (add after thematic works)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Background task fails mid-generation | Partial levels, confusing UX | Add retry logic, status tracking, error notifications |
| LLM produces inconsistent clustering | Poor hierarchy quality | Validate cluster sizes, add guardrails to prompts |
| User zooms before levels ready | Disabled zoom feels broken | Show subtle "generating..." indicator on zoom controls |
| Database bloat from 200+ nodes/conversation | Storage costs increase | Add cleanup job for old/unused hierarchies |
| Animation performance with 120 nodes | Janky transitions | Virtualize nodes, only render visible ones |

## Success Criteria

- ✅ L2 generates and displays in <45 seconds
- ✅ Background generation completes in <6 minutes
- ✅ Smooth zoom transitions between levels (no jank)
- ✅ Parent nodes properly shrink to dots
- ✅ All levels cached (no regeneration on reload)
- ✅ Zoom buttons enable/disable correctly
- ✅ API cost per conversation <$1.00
