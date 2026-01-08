"""
Hierarchical Thematic Analysis Services

Provides 6-level hierarchical thematic structure:
- Level 0: Utterances (raw transcript) - ground truth
- Level 1: Mega-themes (2-4 nodes) - big picture
- Level 2: Themes (5-10 nodes) - major topics
- Level 3: Medium themes (10-15 nodes) - thematic threads
- Level 4: Fine themes (25-35 nodes) - related points grouped
- Level 5: Atomic themes (50-80 nodes) - individual discussion points

Generation strategy: Single bottom-up tree
- Generate L5 from utterances (atomic themes)
- Cluster L5 → L4 → L3 → L2 → L1
- All levels form one coherent hierarchy
"""

from .base_clusterer import BaseClusterer
from .level_5_atomic import Level5AtomicGenerator
from .level_4_clusterer import Level4Clusterer
from .level_3_clusterer import Level3Clusterer
from .level_2_clusterer import Level2Clusterer
from .level_1_clusterer import Level1Clusterer

__all__ = [
    'BaseClusterer',
    'Level5AtomicGenerator',
    'Level4Clusterer',
    'Level3Clusterer',
    'Level2Clusterer',
    'Level1Clusterer',
]
