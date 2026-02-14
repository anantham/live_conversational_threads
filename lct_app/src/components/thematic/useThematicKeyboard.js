import { useEffect } from "react";

/**
 * Keyboard shortcuts for thematic level navigation.
 *
 * - Keys 0-5: jump to that level (if available)
 * - +/=: go to more detail (higher level number)
 * - -/_: go to less detail (lower level number)
 * - Ignores keystrokes when user is typing in an input/textarea
 *
 * @param {object} params
 * @param {number[]} params.availableLevels
 * @param {function} params.handleLevelChange
 * @param {function} params.goToNextLevel
 * @param {function} params.goToPreviousLevel
 */
export function useThematicKeyboard({ availableLevels, handleLevelChange, goToNextLevel, goToPreviousLevel }) {
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
}
