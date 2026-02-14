import { useState, useCallback } from "react";
import ReactFlow, { Controls, Background, MiniMap } from "reactflow";
import "reactflow/dist/style.css";
import { apiFetch } from "../services/apiClient";

import { useThematicLevels } from "./thematic/useThematicLevels";
import { useThematicGraph } from "./thematic/useThematicGraph.jsx";
import { useThematicKeyboard } from "./thematic/useThematicKeyboard";
import LevelSelector from "./thematic/LevelSelector";
import ThematicSettingsPanel from "./thematic/ThematicSettingsPanel";
import UtteranceDetailPanel from "./thematic/UtteranceDetailPanel";
import {
  NODE_TYPES,
  EDGE_TYPES,
  LEVEL_NAMES,
  LEVEL_COLORS,
  getDetailLevelFromZoom,
} from "./thematic/thematicConstants";

/**
 * ThematicView Component
 *
 * Displays AI-generated thematic nodes and their relationships using ReactFlow
 * with hierarchical zoom support (Levels 0-5)
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
  const [showSettings, setShowSettings] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showUtterancePanel, setShowUtterancePanel] = useState(true);
  const [settings, setSettings] = useState({
    fontSize: 'normal',
    utterancesPerTheme: 5,
    model: 'anthropic/claude-3.5-sonnet',
  });

  // Hooks
  const levels = useThematicLevels({ conversationId, thematicData });
  const { nodes, edges, selectedNodeData, selectedNodeUtterances } = useThematicGraph({
    activeData: levels.activeData,
    currentLevel: levels.currentLevel,
    selectedThematicNode,
    hoveredNode,
    highlightedUtterances,
    fontSize: settings.fontSize,
    utterances,
  });
  useThematicKeyboard(levels);

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
        levels.clearLevelCache();
        setShowSettings(false);
      } else {
        console.error('[ThematicView] Regeneration failed:', response.status);
      }
    } catch (error) {
      console.error('[ThematicView] Regeneration error:', error);
    } finally {
      setIsRegenerating(false);
    }
  }, [conversationId, settings, isRegenerating, levels]);

  // Handle ReactFlow viewport changes (zoom) — log only, no auto-switch
  const handleMove = useCallback(
    (event, viewport) => {
      const newLevel = getDetailLevelFromZoom(viewport.zoom);
      if (newLevel !== levels.currentLevel) {
        console.log(`[ThematicView] Zoom at ${viewport.zoom.toFixed(2)} (would be Level ${newLevel}, staying at Level ${levels.currentLevel})`);
      }
    },
    [levels.currentLevel]
  );

  const handleNodeClick = useCallback(
    (event, node) => {
      if (onThematicNodeClick) onThematicNodeClick(node.id);
    },
    [onThematicNodeClick]
  );

  const handleNodeMouseEnter = useCallback((event, node) => {
    setHoveredNode(node.id);
  }, []);

  const handleNodeMouseLeave = useCallback(() => {
    setHoveredNode(null);
  }, []);

  // Empty state
  if (!levels.activeData || !levels.activeData.thematic_nodes || levels.activeData.thematic_nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <p className="text-lg font-semibold mb-2">No Thematic Structure Generated</p>
        <p className="text-sm">Click &quot;Generate Thematic View&quot; in the Analysis menu to create one.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header with Level Controls */}
      <div className="flex items-center justify-between mb-2 px-2 py-1 bg-gray-50 rounded-lg">
        {/* Left: Title and Stats */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {levels.isLoadingLevel && (
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            )}
            <h3 className="text-sm font-semibold text-gray-700">
              Level {levels.currentLevel}: {LEVEL_NAMES[levels.currentLevel]}
            </h3>
          </div>
          <span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded">
            {levels.activeData.thematic_nodes.length} themes · {levels.activeData.edges?.length || 0} edges
          </span>
        </div>

        {/* Center: Level Selector */}
        <LevelSelector
          currentLevel={levels.currentLevel}
          availableLevels={levels.availableLevels}
          levelCounts={levels.levelCounts}
          isLoadingLevel={levels.isLoadingLevel}
          onLevelChange={levels.handleLevelChange}
          onPreviousLevel={levels.goToPreviousLevel}
          onNextLevel={levels.goToNextLevel}
          canGoPrevious={levels.canGoPrevious}
          canGoNext={levels.canGoNext}
        />

        {/* Right: Settings and Fullscreen */}
        <div className="flex items-center gap-2 relative">
          {levels.activeData.summary?.model && (
            <span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded">
              {levels.activeData.summary.model.split("/").pop()}
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

          <ThematicSettingsPanel
            showSettings={showSettings}
            setShowSettings={setShowSettings}
            settings={settings}
            setSettings={setSettings}
            onRegenerate={handleRegenerate}
            isRegenerating={isRegenerating}
          />

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
        <div className={`text-xs px-3 py-1 rounded-full ${LEVEL_COLORS[levels.currentLevel]?.bg || 'bg-gray-500'} text-white`}>
          {levels.currentLevel === 0 && "💬 Raw transcript - every utterance"}
          {levels.currentLevel === 1 && "🌐 Highest abstraction - major narrative arcs"}
          {levels.currentLevel === 2 && "📚 Core themes and discussion areas"}
          {levels.currentLevel === 3 && "📄 Topic-level groupings"}
          {levels.currentLevel === 4 && "💬 Fine-grained exchanges"}
          {levels.currentLevel === 5 && "🔬 Atomic - individual contributions"}
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

      {/* Utterance Detail Panel */}
      <UtteranceDetailPanel
        selectedNodeData={selectedNodeData}
        selectedNodeUtterances={selectedNodeUtterances}
        showPanel={showUtterancePanel}
        setShowPanel={setShowUtterancePanel}
        onUtteranceClick={onUtteranceClick}
      />
    </div>
  );
}
