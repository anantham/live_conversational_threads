import { useState, useCallback, useEffect } from "react";
import { apiFetch } from "../../services/apiClient";
import { DISPLAY_TO_API_LEVEL, API_TO_DISPLAY_LEVEL } from "./thematicConstants";

/**
 * Manages hierarchical level state, polling for available levels,
 * fetching level data, and level navigation.
 *
 * @param {object} params
 * @param {string} params.conversationId - UUID of the conversation
 * @param {object} params.thematicData - Thematic data prop from parent (for cache seeding)
 * @returns Level state, navigation handlers, and activeData
 */
export function useThematicLevels({ conversationId, thematicData }) {
  const [currentLevel, setCurrentLevel] = useState(1); // Default to Display Level 1 (Themes)
  const [availableLevels, setAvailableLevels] = useState([1]); // Start with Themes
  const [levelCounts, setLevelCounts] = useState({});
  const [levelData, setLevelData] = useState({}); // Cache for each level's data
  const [isLoadingLevel, setIsLoadingLevel] = useState(false);

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
    for (let level = currentLevel - 1; level >= 0; level--) {
      if (availableLevels.includes(level)) {
        handleLevelChange(level);
        return;
      }
    }
  }, [currentLevel, availableLevels, handleLevelChange]);

  const goToNextLevel = useCallback(() => {
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

  // Get data for current level (prefer cached level data over prop)
  const activeData = levelData[currentLevel] || thematicData;

  // Clear level cache (for regeneration)
  const clearLevelCache = useCallback(() => {
    setLevelData({});
  }, []);

  return {
    currentLevel,
    availableLevels,
    levelCounts,
    isLoadingLevel,
    activeData,
    handleLevelChange,
    goToPreviousLevel,
    goToNextLevel,
    canGoPrevious,
    canGoNext,
    clearLevelCache,
  };
}
