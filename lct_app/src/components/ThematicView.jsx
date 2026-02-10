import { useState, useMemo, useCallback, useEffect } from "react";
import ReactFlow, { Controls, Background, MiniMap } from "reactflow";
import dagre from "dagre";
import "reactflow/dist/style.css";
import { apiFetch } from "../services/apiClient";

// Define outside component to prevent ReactFlow warnings
const NODE_TYPES = {};
const EDGE_TYPES = {};

// Level mapping: Display levels (0=broadest to 5=finest) ↔ API levels
// Display L0 (Mega-themes) → API L1, Display L5 (Utterances) → API L0
const DISPLAY_TO_API_LEVEL = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 0 };
const API_TO_DISPLAY_LEVEL = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 0: 5 };

/**
 * ThematicView Component
 *
 * Displays AI-generated thematic nodes and their relationships using ReactFlow
 * with hierarchical zoom support (Levels 1-5)
 *
 * Props:
 * - thematicData: Object containing thematic_nodes and edges arrays
 * - selectedThematicNode: ID of currently selected thematic node
 * - onThematicNodeClick: Callback when a thematic node is clicked
 * - highlightedUtterances: Array of utterance IDs that are selected (to highlight parent themes)
 * - isFullScreen: Boolean for fullscreen mode
 * - setIsFullScreen: Function to toggle fullscreen mode
 * - conversationId: UUID of conversation (for fetching hierarchical levels)
 * - utterances: Array of all utterances (for displaying in detail panel)
 * - onUtteranceClick: Callback when an utterance is clicked in the detail panel
 */
export default function ThematicView({
  thematicData,
  selectedThematicNode,
  onThematicNodeClick,
  highlightedUtterances = [],
  isFullScreen,
  setIsFullScreen,
  conversationId,
  utterances = [],
  onUtteranceClick,
}) {
  const [hoveredNode, setHoveredNode] = useState(null);
  const [currentLevel, setCurrentLevel] = useState(1); // Default to Display Level 1 (Themes)
  const [availableLevels, setAvailableLevels] = useState([1]); // Start with Themes
  const [levelCounts, setLevelCounts] = useState({});
  const [levelData, setLevelData] = useState({}); // Cache for each level's data
  const [isLoadingLevel, setIsLoadingLevel] = useState(false); // Loading state for level fetch

  // Settings panel state
  const [showSettings, setShowSettings] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showUtterancePanel, setShowUtterancePanel] = useState(true); // Utterance detail panel visible by default
  const [settings, setSettings] = useState({
    fontSize: 'normal', // 'small', 'normal', 'large'
    utterancesPerTheme: 5,
    model: 'anthropic/claude-3.5-sonnet',
  });

  // Available models for selection
  const availableModels = [
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Fast & capable' },
    { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', description: 'Most capable' },
    { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI flagship' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast & affordable' },
    { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5', description: 'Google flagship' },
  ];

  // Font size classes based on setting
  const fontSizeClasses = {
    small: { label: 'text-xs', summary: 'text-[10px]', badge: 'text-[9px]' },
    normal: { label: 'text-sm', summary: 'text-xs', badge: 'text-xs' },
    large: { label: 'text-base', summary: 'text-sm', badge: 'text-sm' },
  };

  // Map ReactFlow zoom level to hierarchical detail level
  const getDetailLevelFromZoom = useCallback((zoom) => {
    if (zoom < 0.3) return 1;      // Mega-themes
    if (zoom < 0.6) return 2;      // Themes (default)
    if (zoom < 1.0) return 3;      // Medium detail
    if (zoom < 1.5) return 4;      // Fine detail
    return 5;                       // Atomic detail
  }, []);

  // Cache incoming thematic data by display level (converts from API level)
  useEffect(() => {
    if (thematicData && thematicData.summary?.level !== undefined) {
      const apiLevel = thematicData.summary.level;
      const displayLevel = API_TO_DISPLAY_LEVEL[apiLevel];
      console.log(`[ThematicView] Caching data: API level ${apiLevel} → Display level ${displayLevel}`);
      setLevelData((prev) => ({
        ...prev,
        [displayLevel]: thematicData,
      }));
    }
  }, [thematicData]);

  // Poll for available levels every 5 seconds
  useEffect(() => {
    if (!conversationId) return;

    const pollLevels = async () => {
      const startTime = performance.now();
      try {
        const response = await apiFetch(`/api/conversations/${conversationId}/themes/levels`);
        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(0);

        if (response.ok) {
          const data = await response.json();
          // Convert API levels to display levels
          const displayLevels = data.available_levels.map(apiLvl => API_TO_DISPLAY_LEVEL[apiLvl]);
          const displayCounts = {};
          for (const [apiLvl, count] of Object.entries(data.level_counts)) {
            const displayLvl = API_TO_DISPLAY_LEVEL[parseInt(apiLvl)];
            displayCounts[displayLvl] = count;
          }
          console.log(`[ThematicView] Poll levels (${duration}ms): API ${data.available_levels} → Display ${displayLevels}`);
          setAvailableLevels(displayLevels);
          setLevelCounts(displayCounts);
        } else {
          console.error(`[ThematicView] Poll levels failed (${duration}ms):`, response.status);
        }
      } catch (error) {
        const endTime = performance.now();
        const duration = (endTime - startTime).toFixed(0);
        console.error(`[ThematicView] Error polling levels (${duration}ms):`, error);
      }
    };

    // Poll immediately and then every 5 seconds
    pollLevels();
    const interval = setInterval(pollLevels, 5000);

    return () => clearInterval(interval);
  }, [conversationId]);

  // Fetch data for a specific display level (converts to API level internally)
  const fetchLevelData = useCallback(async (displayLevel) => {
    if (!conversationId) return;

    const apiLevel = DISPLAY_TO_API_LEVEL[displayLevel];
    setIsLoadingLevel(true);
    const startTime = performance.now();
    try {
      console.log(`[ThematicView] Fetching display level ${displayLevel} (API level ${apiLevel})...`);
      const response = await apiFetch(`/api/conversations/${conversationId}/themes?level=${apiLevel}`);
      const endTime = performance.now();
      const duration = (endTime - startTime).toFixed(0);

      if (response.ok) {
        const data = await response.json();
        console.log(`[ThematicView] Fetched display level ${displayLevel} (${duration}ms): ${data.thematic_nodes?.length || 0} nodes`);
        setLevelData((prev) => ({
          ...prev,
          [displayLevel]: data,
        }));
      } else {
        console.error(`[ThematicView] Failed to fetch display level ${displayLevel} (${duration}ms):`, response.status);
      }
    } catch (error) {
      const endTime = performance.now();
      const duration = (endTime - startTime).toFixed(0);
      console.error(`[ThematicView] Error fetching display level ${displayLevel} (${duration}ms):`, error);
    } finally {
      setIsLoadingLevel(false);
    }
  }, [conversationId]);

  // Handle explicit level change (from UI buttons)
  const handleLevelChange = useCallback((newLevel) => {
    if (newLevel < 0 || newLevel > 5) return;
    if (newLevel === currentLevel) return;
    
    // Check if level is available
    if (!availableLevels.includes(newLevel)) {
      console.log(`[ThematicView] Level ${newLevel} not available yet`);
      return;
    }

    console.log(`[ThematicView] Switching to level ${newLevel}`);
    setCurrentLevel(newLevel);

    // Fetch data if not cached
    if (!levelData[newLevel]) {
      fetchLevelData(newLevel);
    }
  }, [currentLevel, availableLevels, levelData, fetchLevelData]);

  // Navigate to previous/next available level
  const goToPreviousLevel = useCallback(() => {
    // Find the next lower available level
    for (let level = currentLevel - 1; level >= 0; level--) {
      if (availableLevels.includes(level)) {
        handleLevelChange(level);
        return;
      }
    }
  }, [currentLevel, availableLevels, handleLevelChange]);

  const goToNextLevel = useCallback(() => {
    // Find the next higher available level
    for (let level = currentLevel + 1; level <= 5; level++) {
      if (availableLevels.includes(level)) {
        handleLevelChange(level);
        return;
      }
    }
  }, [currentLevel, availableLevels, handleLevelChange]);

  // Check if we can navigate
  const canGoPrevious = availableLevels.some(l => l < currentLevel);
  const canGoNext = availableLevels.some(l => l > currentLevel);

  // Keyboard shortcuts for level navigation
  useEffect(() => {
    const handleKeyDown = (event) => {
      // Ignore if user is typing in an input
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
      
      // Number keys 0-5 to jump to level
      if (event.key >= '0' && event.key <= '5') {
        const level = parseInt(event.key);
        if (availableLevels.includes(level)) {
          handleLevelChange(level);
        }
        return;
      }

      // +/= to go to more detail (higher level number)
      if (event.key === '+' || event.key === '=') {
        goToNextLevel();
        return;
      }

      // - to go to less detail (lower level number)
      if (event.key === '-' || event.key === '_') {
        goToPreviousLevel();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [availableLevels, handleLevelChange, goToNextLevel, goToPreviousLevel]);

  // Regenerate thematic structure with current settings
  const handleRegenerate = useCallback(async () => {
    if (!conversationId || isRegenerating) return;

    setIsRegenerating(true);
    console.log('[ThematicView] Regenerating with settings:', settings);

    try {
      const params = new URLSearchParams({
        model: settings.model,
        utterances_per_atomic_theme: settings.utterancesPerTheme.toString(),
        force_regenerate: 'true',
      });

      const response = await apiFetch(
        `/api/conversations/${conversationId}/themes/generate?${params}`,
        { method: 'POST' }
      );

      if (response.ok) {
        const data = await response.json();
        console.log('[ThematicView] Regeneration started:', data);
        // Clear cached level data so it refetches
        setLevelData({});
        setShowSettings(false);
      } else {
        console.error('[ThematicView] Regeneration failed:', response.status);
      }
    } catch (error) {
      console.error('[ThematicView] Regeneration error:', error);
    } finally {
      setIsRegenerating(false);
    }
  }, [conversationId, settings, isRegenerating]);

  // Handle ReactFlow viewport changes (zoom)
  // NOTE: We now ONLY log zoom changes, we don't try to switch levels based on ReactFlow zoom
  // The level switching should be done via explicit UI controls, not zoom gestures
  const handleMove = useCallback(
    (event, viewport) => {
      const newLevel = getDetailLevelFromZoom(viewport.zoom);

      // Only log for debugging - don't auto-switch levels as it causes confusion
      if (newLevel !== currentLevel) {
        console.log(`[ThematicView] Zoom at ${viewport.zoom.toFixed(2)} (would be Level ${newLevel}, staying at Level ${currentLevel})`);
      }
      
      // Only switch if the level is actually available AND explicitly requested
      // Auto-switching on zoom causes nodes to vanish when data isn't available
      // To enable auto-switching, uncomment below:
      /*
      if (newLevel !== currentLevel && availableLevels.includes(newLevel)) {
        console.log(`[ThematicView] Zoom changed: ${viewport.zoom.toFixed(2)} → Level ${newLevel}`);
        setCurrentLevel(newLevel);

        if (!levelData[newLevel]) {
          fetchLevelData(newLevel);
        }
      }
      */
    },
    [currentLevel, availableLevels, levelData, getDetailLevelFromZoom, fetchLevelData]
  );

  // Check if a thematic node should be highlighted based on utterance selection
  const isNodeHighlightedByUtterance = useCallback(
    (nodeUtteranceIds) => {
      if (!highlightedUtterances || highlightedUtterances.length === 0) return false;
      return nodeUtteranceIds?.some((uttId) => highlightedUtterances.includes(uttId));
    },
    [highlightedUtterances]
  );

  // Format timestamp helper
  const formatTimestamp = (seconds) => {
    if (!seconds && seconds !== 0) return "";
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  };

  // Get data for current level (prefer cached level data over prop)
  const activeData = levelData[currentLevel] || thematicData;

  // Generate nodes and edges from thematic data
  const { nodes, edges } = useMemo(() => {
    console.log(`[ThematicView] useMemo triggered - Level ${currentLevel}`);
    console.log("[ThematicView] Active data:", activeData);
    console.log("[ThematicView] DIAGNOSTIC - activeData.edges:", activeData?.edges);
    console.log("[ThematicView] DIAGNOSTIC - typeof activeData.edges:", typeof activeData?.edges);
    console.log("[ThematicView] DIAGNOSTIC - Array.isArray(activeData.edges):", Array.isArray(activeData?.edges));

    if (!activeData || !activeData.thematic_nodes) {
      console.log("[ThematicView] No thematic data or nodes - returning empty");
      return { nodes: [], edges: [] };
    }

    const thematicNodes = activeData.thematic_nodes;
    const thematicEdges = activeData.edges || [];

    // FIXED: Create dagre graph INSIDE useMemo to prevent stale reference issues
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setGraph({ rankdir: "TB", nodesep: 140, ranksep: 200 });
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    console.log(`[ThematicView] Level ${currentLevel}: Processing`, thematicNodes.length, "nodes and", thematicEdges.length, "edges");

    // Create ReactFlow nodes
    const nodes = thematicNodes.map((theme) => {
      const isSelected = selectedThematicNode === theme.id;
      const isHighlighted = isNodeHighlightedByUtterance(theme.utterance_ids);
      const isHovered = hoveredNode === theme.id;

      // Check if we're in "filtering mode" (utterances are selected)
      const isFilteringActive = highlightedUtterances && highlightedUtterances.length > 0;
      const isDimmed = isFilteringActive && !isSelected && !isHighlighted;

      let background, border, boxShadow, opacity;

      if (isSelected) {
        // Selected: Orange
        background = "#FED7AA"; // orange-200
        border = "3px solid #F97316"; // orange-500
        boxShadow = "0px 0px 20px rgba(249, 115, 22, 0.6)";
        opacity = 1;
      } else if (isHighlighted) {
        // Parent of selected utterance: Green
        background = "#BBF7D0"; // green-200
        border = "3px solid #22C55E"; // green-500
        boxShadow = "0px 0px 15px rgba(34, 197, 94, 0.5)";
        opacity = 1;
      } else if (isHovered) {
        background = "#E0E7FF"; // indigo-100
        border = "2px solid #6366F1"; // indigo-500
        boxShadow = "0px 0px 10px rgba(99, 102, 241, 0.4)";
        opacity = isDimmed ? 0.3 : 1;
      } else {
        background = "#FFFFFF";
        border = "2px solid #CBD5E1"; // slate-300
        boxShadow = "0px 2px 4px rgba(0, 0, 0, 0.1)";
        opacity = isDimmed ? 0.3 : 1;
      }

      // Get node type color accent
      const nodeTypeColors = {
        discussion: "#3B82F6", // blue-500
        claim: "#EF4444", // red-500
        worldview: "#8B5CF6", // violet-500
        normative: "#F59E0B", // amber-500
        question: "#10B981", // emerald-500
        resolution: "#06B6D4", // cyan-500
        debate: "#EC4899", // pink-500
        consensus: "#14B8A6", // teal-500
        tangent: "#6B7280", // gray-500
        utterance: "#9333EA", // purple-600 (for Level 0)
        default: "#6B7280", // gray-500
      };

      const nodeTypeColor = nodeTypeColors[theme.node_type] || nodeTypeColors.default;
      const fontClasses = fontSizeClasses[settings.fontSize] || fontSizeClasses.normal;

      return {
        id: theme.id,
        data: {
          label: (
            <div className="p-3 flex flex-col gap-1" style={{ width: '280px', maxHeight: '180px', overflow: 'hidden' }}>
              {/* Node Type Badge */}
              <div className="flex items-center gap-2 mb-1 flex-shrink-0">
                <span
                  className={`px-2 py-0.5 ${fontClasses.badge} font-semibold rounded-full text-white`}
                  style={{ backgroundColor: nodeTypeColor, maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {theme.node_type}
                </span>
                <span className={`${fontClasses.badge} text-gray-500 flex-shrink-0`}>
                  {theme.utterance_ids?.length || 0} utt
                </span>
              </div>

              {/* Theme Label */}
              <div
                className={`font-bold ${fontClasses.label} text-gray-900 mb-1 flex-shrink-0`}
                style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
              >
                {theme.label}
              </div>

              {/* Theme Summary */}
              <div
                className={`${fontClasses.summary} text-gray-600 leading-relaxed flex-grow`}
                style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
              >
                {theme.summary}
              </div>

              {/* Timestamp Range */}
              {theme.timestamp_start !== undefined && theme.timestamp_end !== undefined && (
                <div className="text-xs text-gray-500 mt-1 font-mono flex-shrink-0">
                  {formatTimestamp(theme.timestamp_start)} - {formatTimestamp(theme.timestamp_end)}
                </div>
              )}
            </div>
          ),
        },
        position: { x: 0, y: 0 }, // Dagre will handle positioning
        style: {
          background,
          border,
          boxShadow,
          opacity,
          borderRadius: "12px",
          padding: "0",
          width: "300px",
          maxHeight: "200px",
          overflow: "hidden",
          transition: "all 0.3s ease-in-out",
          cursor: "pointer",
        },
      };
    });

    // Create ReactFlow edges
    const edges = thematicEdges.map((edge) => {
      const isConnectedToSelected =
        selectedThematicNode === edge.source || selectedThematicNode === edge.target;

      const edgeType = (edge.type || edge.relationship_type || "").toLowerCase();
      const isSupportive = ["supports", "affirms", "enables", "informs", "builds_on"].some(t => edgeType.includes(t));
      const isContradictory = ["contradicts", "opposes", "refutes", "challenges", "conflicts"].some(t => edgeType.includes(t));

      const baseColor = isConnectedToSelected
        ? "#F97316"
        : isSupportive
          ? "#22C55E"
          : isContradictory
            ? "#EF4444"
            : "#94A3B8";

      return {
        id: `${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        label: edge.type || edge.relationship_type,
        animated: isConnectedToSelected,
        style: {
          stroke: baseColor,
          strokeWidth: isConnectedToSelected ? 3 : 2,
          opacity: isConnectedToSelected ? 1 : 0.8,
          transition: "all 0.3s ease-in-out",
        },
        labelStyle: {
          fontSize: "10px",
          fontWeight: "600",
          fill: baseColor,
        },
        markerEnd: {
          type: "arrowclosed",
          width: 15,
          height: 15,
          color: baseColor,
        },
      };
    });

    // Add nodes & edges to Dagre graph for auto-layout
    nodes.forEach((node) =>
      dagreGraph.setNode(node.id, { width: 350, height: 200 })
    );
    edges.forEach((edge) => dagreGraph.setEdge(edge.source, edge.target));

    dagre.layout(dagreGraph); // Apply layout

    // FIXED: Update positions from Dagre with defensive fallback
    const positionedNodes = nodes.map((node, index) => {
      const dagreNode = dagreGraph.node(node.id);
      // Defensive: if dagre didn't compute position, use grid fallback
      const position = dagreNode 
        ? { x: dagreNode.x, y: dagreNode.y }
        : { x: (index % 3) * 450, y: Math.floor(index / 3) * 280 };
      
      if (!dagreNode) {
        console.warn(`[ThematicView] Dagre missing position for node ${node.id}, using fallback`);
      }
      
      return {
        ...node,
        position,
      };
    });

    // Debug logging before returning
    console.log("[ThematicView] Created", positionedNodes.length, "nodes with IDs:", positionedNodes.map(n => n.id));
    console.log("[ThematicView] Created", edges.length, "edges for ReactFlow");
    if (edges.length > 0) {
      console.log("[ThematicView] First edge:", edges[0]);
      console.log("[ThematicView] All edges:", edges.map(e => `${e.source} -> ${e.target} (${e.label})`));
    }

    // DIAGNOSTIC: Verify edge source/target match node IDs
    const nodeIds = new Set(positionedNodes.map(n => n.id));
    const invalidEdges = edges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
    if (invalidEdges.length > 0) {
      console.error("[ThematicView] DIAGNOSTIC - INVALID EDGES (source/target not in nodes):", invalidEdges);
      console.error("[ThematicView] DIAGNOSTIC - Available node IDs:", [...nodeIds]);
    } else if (edges.length > 0) {
      console.log("[ThematicView] DIAGNOSTIC - All edges valid (source/target match node IDs)");
    }

    return { nodes: positionedNodes, edges };
  }, [activeData, currentLevel, selectedThematicNode, hoveredNode, highlightedUtterances, isNodeHighlightedByUtterance, settings.fontSize, fontSizeClasses]);

  // Get selected node and its utterances
  const selectedNodeData = useMemo(() => {
    if (!selectedThematicNode || !activeData?.thematic_nodes) return null;
    return activeData.thematic_nodes.find(n => n.id === selectedThematicNode);
  }, [selectedThematicNode, activeData]);

  const selectedNodeUtterances = useMemo(() => {
    if (!selectedNodeData?.utterance_ids || !utterances.length) return [];
    const uttMap = new Map(utterances.map(u => [u.id, u]));
    return selectedNodeData.utterance_ids
      .map(id => uttMap.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.timestamp_start || 0) - (b.timestamp_start || 0));
  }, [selectedNodeData, utterances]);

  // Handle node click
  const handleNodeClick = useCallback(
    (event, node) => {
      if (onThematicNodeClick) {
        onThematicNodeClick(node.id);
      }
    },
    [onThematicNodeClick]
  );

  // Handle node hover
  const handleNodeMouseEnter = useCallback((event, node) => {
    setHoveredNode(node.id);
  }, []);

  const handleNodeMouseLeave = useCallback(() => {
    setHoveredNode(null);
  }, []);

  if (!activeData || !activeData.thematic_nodes || activeData.thematic_nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <p className="text-lg font-semibold mb-2">No Thematic Structure Generated</p>
        <p className="text-sm">Click "Generate Thematic View" in the Analysis menu to create one.</p>
      </div>
    );
  }

  // Level names for display (L0=broadest to L5=finest)
  const levelNames = {
    0: "Mega-Themes",
    1: "Themes",
    2: "Medium Detail",
    3: "Fine Detail",
    4: "Atomic Themes",
    5: "Utterances",
  };

  // Level colors for visual distinction (warm=broad, cool=detailed)
  const levelColors = {
    0: { bg: "bg-red-500", ring: "ring-red-300", text: "text-red-600" },
    1: { bg: "bg-orange-500", ring: "ring-orange-300", text: "text-orange-600" },
    2: { bg: "bg-yellow-500", ring: "ring-yellow-300", text: "text-yellow-600" },
    3: { bg: "bg-green-500", ring: "ring-green-300", text: "text-green-600" },
    4: { bg: "bg-blue-500", ring: "ring-blue-300", text: "text-blue-600" },
    5: { bg: "bg-purple-500", ring: "ring-purple-300", text: "text-purple-600" },
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header with Level Controls */}
      <div className="flex items-center justify-between mb-2 px-2 py-1 bg-gray-50 rounded-lg">
        {/* Left: Title and Stats */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {isLoadingLevel && (
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            )}
            <h3 className="text-sm font-semibold text-gray-700">
              Level {currentLevel}: {levelNames[currentLevel]}
            </h3>
          </div>
          <span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded">
            {activeData.thematic_nodes.length} themes · {activeData.edges?.length || 0} edges
          </span>
        </div>

        {/* Center: Level Selector */}
        <div className="flex items-center gap-1">
          {/* Previous Level Button */}
          <button
            onClick={goToPreviousLevel}
            disabled={!canGoPrevious || isLoadingLevel}
            className={`px-2 py-1 rounded-l-lg text-sm font-bold transition ${
              canGoPrevious && !isLoadingLevel
                ? "bg-gray-200 hover:bg-gray-300 text-gray-700"
                : "bg-gray-100 text-gray-400 cursor-not-allowed"
            }`}
            title="Previous detail level (more abstract)"
          >
            ◀ Less
          </button>

          {/* Level Buttons */}
          <div className="flex items-center bg-white rounded-lg shadow-inner border border-gray-200">
            {[0, 1, 2, 3, 4, 5].map((level) => {
              const isAvailable = availableLevels.includes(level);
              const isCurrent = level === currentLevel;
              const colors = levelColors[level];
              const count = levelCounts[level] || 0;

              return (
                <button
                  key={level}
                  onClick={() => handleLevelChange(level)}
                  disabled={!isAvailable || isLoadingLevel}
                  className={`
                    relative px-3 py-1.5 text-xs font-semibold transition-all duration-200
                    ${isCurrent 
                      ? `${colors.bg} text-white shadow-md ring-2 ${colors.ring} z-10` 
                      : isAvailable 
                        ? `bg-white ${colors.text} hover:bg-gray-50` 
                        : "bg-gray-50 text-gray-300 cursor-not-allowed"
                    }
                    ${level === 0 ? "rounded-l" : ""}
                    ${level === 5 ? "rounded-r" : ""}
                  `}
                  title={isAvailable 
                    ? `${levelNames[level]} (${count} themes)` 
                    : `${levelNames[level]} - Not generated yet`
                  }
                >
                  <span className="block">{level}</span>
                  {isAvailable && (
                    <span className={`block text-[9px] ${isCurrent ? "text-white/80" : "text-gray-400"}`}>
                      {count}
                    </span>
                  )}
                  {!isAvailable && (
                    <span className="block text-[9px] text-gray-300">—</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Next Level Button */}
          <button
            onClick={goToNextLevel}
            disabled={!canGoNext || isLoadingLevel}
            className={`px-2 py-1 rounded-r-lg text-sm font-bold transition ${
              canGoNext && !isLoadingLevel
                ? "bg-gray-200 hover:bg-gray-300 text-gray-700"
                : "bg-gray-100 text-gray-400 cursor-not-allowed"
            }`}
            title="Next detail level (more granular)"
          >
            More ▶
          </button>
        </div>

        {/* Right: Settings and Fullscreen */}
        <div className="flex items-center gap-2 relative">
          {activeData.summary?.model && (
            <span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded">
              {activeData.summary.model.split("/").pop()}
            </span>
          )}

          {/* Settings Button */}
          <button
            className={`px-2 py-1 rounded-lg shadow-md transition text-sm ${
              showSettings
                ? "bg-purple-500 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
          >
            ⚙️
          </button>

          {/* Settings Panel */}
          {showSettings && (
            <div className="absolute top-full right-0 mt-2 w-80 bg-white rounded-lg shadow-xl border border-gray-200 z-50 p-4">
              <div className="flex justify-between items-center mb-3">
                <h4 className="font-semibold text-gray-800">Thematic View Settings</h4>
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>

              {/* Font Size */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-600 mb-1">Font Size</label>
                <div className="flex gap-1">
                  {['small', 'normal', 'large'].map((size) => (
                    <button
                      key={size}
                      onClick={() => setSettings(s => ({ ...s, fontSize: size }))}
                      className={`flex-1 px-2 py-1 text-xs rounded transition ${
                        settings.fontSize === size
                          ? 'bg-purple-500 text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {size.charAt(0).toUpperCase() + size.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Granularity */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Granularity: ~{settings.utterancesPerTheme} utterances per atomic theme
                </label>
                <input
                  type="range"
                  min="3"
                  max="10"
                  value={settings.utterancesPerTheme}
                  onChange={(e) => setSettings(s => ({ ...s, utterancesPerTheme: parseInt(e.target.value) }))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                  <span>More themes</span>
                  <span>Fewer themes</span>
                </div>
              </div>

              {/* Model Selection */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-600 mb-1">Model</label>
                <select
                  value={settings.model}
                  onChange={(e) => setSettings(s => ({ ...s, model: e.target.value }))}
                  className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-purple-300"
                >
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} - {model.description}
                    </option>
                  ))}
                </select>
              </div>

              {/* Regenerate Button */}
              <button
                onClick={handleRegenerate}
                disabled={isRegenerating}
                className={`w-full py-2 rounded-lg font-medium text-sm transition ${
                  isRegenerating
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-purple-500 text-white hover:bg-purple-600 active:scale-98'
                }`}
              >
                {isRegenerating ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Regenerating...
                  </span>
                ) : (
                  '🔄 Regenerate Themes'
                )}
              </button>

              <p className="text-[10px] text-gray-400 mt-2 text-center">
                Regeneration replaces all existing themes
              </p>
            </div>
          )}

          {/* Fullscreen Button */}
          {setIsFullScreen && (
            <button
              className="px-3 py-1 bg-blue-100 text-blue-600 rounded-lg shadow-md hover:bg-blue-200 active:scale-95 transition text-lg"
              onClick={() => setIsFullScreen(!isFullScreen)}
              title={isFullScreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullScreen ? "🡼" : "⛶"}
            </button>
          )}
        </div>
      </div>

      {/* Level Description Bar */}
      <div className="flex items-center justify-between mb-2 px-2">
        <div className="text-xs text-gray-400 flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 bg-gray-200 rounded text-[10px] font-mono">0-5</kbd>
          <span>jump</span>
          <kbd className="px-1.5 py-0.5 bg-gray-200 rounded text-[10px] font-mono ml-2">+/-</kbd>
          <span>navigate</span>
        </div>
        <div className={`text-xs px-3 py-1 rounded-full ${levelColors[currentLevel]?.bg || 'bg-gray-500'} text-white`}>
          {currentLevel === 0 && "💬 Raw transcript - every utterance"}
          {currentLevel === 1 && "🌐 Highest abstraction - major narrative arcs"}
          {currentLevel === 2 && "📚 Core themes and discussion areas"}
          {currentLevel === 3 && "📄 Topic-level groupings"}
          {currentLevel === 4 && "💬 Fine-grained exchanges"}
          {currentLevel === 5 && "🔬 Atomic - individual contributions"}
        </div>
        <div className="w-24"></div> {/* Spacer for balance */}
      </div>

      {/* ReactFlow Graph */}
      <div className={`${selectedNodeData && showUtterancePanel ? 'flex-[3]' : 'flex-grow'} border rounded-lg overflow-hidden bg-gray-50 min-h-0`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          onNodeClick={handleNodeClick}
          onNodeMouseEnter={handleNodeMouseEnter}
          onNodeMouseLeave={handleNodeMouseLeave}
          onMove={handleMove}
          zoomOnPinch={true}
          zoomOnScroll={true}
          panOnDrag={true}
          panOnScroll={false}
        >
          <Controls />
          <Background color="#E5E7EB" gap={16} />
          <MiniMap
            nodeStrokeWidth={3}
            zoomable
            pannable
            style={{
              backgroundColor: "#F9FAFB",
            }}
          />
        </ReactFlow>
      </div>

      {/* Utterance Detail Panel - Shows when a node is selected */}
      {selectedNodeData && showUtterancePanel && (
        <div className="flex-1 min-h-[120px] max-h-[200px] border rounded-lg bg-white shadow-sm overflow-hidden flex flex-col mt-2">
          {/* Panel Header */}
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-700">
                📝 Utterances in "{selectedNodeData.label}"
              </span>
              <span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded">
                {selectedNodeUtterances.length} utterances
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">
                {formatTimestamp(selectedNodeData.timestamp_start)} - {formatTimestamp(selectedNodeData.timestamp_end)}
              </span>
              <button
                onClick={() => setShowUtterancePanel(false)}
                className="text-gray-400 hover:text-gray-600 px-1"
                title="Hide panel"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Utterance List */}
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {selectedNodeUtterances.length === 0 ? (
              <div className="text-center text-gray-400 text-sm py-4">
                No utterance data available
              </div>
            ) : (
              <div className="space-y-1">
                {selectedNodeUtterances.map((utt) => (
                  <div
                    key={utt.id}
                    onClick={() => onUtteranceClick && onUtteranceClick(utt)}
                    className="flex items-start gap-2 p-2 rounded-lg hover:bg-blue-50 cursor-pointer transition group"
                  >
                    {/* Timestamp Badge */}
                    <span className="flex-shrink-0 text-xs font-mono bg-blue-100 text-blue-700 px-2 py-1 rounded group-hover:bg-blue-200">
                      {formatTimestamp(utt.timestamp_start)}
                    </span>

                    {/* Speaker */}
                    <span className="flex-shrink-0 text-xs font-semibold text-purple-600 min-w-[60px]">
                      {utt.speaker_name || utt.speaker_id || 'Speaker'}:
                    </span>

                    {/* Text */}
                    <span className="text-sm text-gray-700 flex-grow line-clamp-2">
                      {utt.text}
                    </span>

                    {/* Click indicator */}
                    <span className="flex-shrink-0 text-gray-300 group-hover:text-blue-500 text-xs">
                      →
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Show panel button when hidden */}
      {selectedNodeData && !showUtterancePanel && (
        <button
          onClick={() => setShowUtterancePanel(true)}
          className="mt-2 px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition"
        >
          📝 Show {selectedNodeUtterances.length} utterances for "{selectedNodeData.label}"
        </button>
      )}
    </div>
  );
}
