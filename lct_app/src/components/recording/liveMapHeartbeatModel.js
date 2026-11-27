// Test intent:
// - While recording, the canvas says when the next live map will run and how many new words it will cover,
//   so a closed map panel never leaves the reader guessing whether anything is happening.
// - "Map now" is offered only when a deliberate request can actually run and would send new words.
// - The label is built from counts and times alone; it never contains transcript text.

// A live update waits for this many new confirmed characters, so a pause in speech never re-sends the same words.
export const MIN_NEW_MAP_CHARS = 120;

function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

/**
 * What the canvas shows for the live map: a short label, whether work is in flight, and the one action on offer
 * ('map' runs an update now, 'open' opens the map panel, null offers nothing).
 */
export function liveMapHeartbeat(schedule, finalText = '', now = Date.now()) {
  if (!schedule) return null;
  const mappedChars = Math.min(schedule.mappedChars || 0, finalText.length);
  const newChars = finalText.length - mappedChars;
  const newWords = countWords(finalText.slice(mappedChars));
  const pending = newWords ? ` · ${plural(newWords, 'new word')}` : '';
  // Offered only for new words: a tail of spaces or line breaks is nothing to send.
  const mapAction = schedule.canMapNow && newWords > 0 ? 'map' : null;
  switch (schedule.state) {
    case 'checking':
      // Setup is still being checked; say nothing rather than guess.
      return null;
    case 'mapping':
      return { label: 'Mapping…', busy: true, action: null };
    case 'scheduled': {
      const enough = schedule.complete ? newChars > 0 : newChars >= schedule.minNewChars;
      if (!enough) return { label: schedule.complete ? 'Map is up to date' : `Listening${pending}`, busy: false, action: mapAction };
      const seconds = Math.ceil((schedule.lastAttemptAt + schedule.intervalMs - now) / 1000);
      return { label: seconds > 0 ? `Next map in ${seconds} s${pending}` : `Mapping next${pending}`, busy: false, action: mapAction };
    }
    case 'limit':
      return { label: `Automatic updates used${pending}`, busy: false, action: mapAction };
    case 'error':
      // A failed attempt already recorded its text as sent, so the count would read zero; offer the retry anyway.
      return { label: 'Last map did not finish', busy: false, action: schedule.canMapNow ? 'map' : 'open', actionLabel: schedule.canMapNow ? 'Try again' : 'See why' };
    case 'needs-consent':
      return { label: 'Live map is off', busy: false, action: 'open', actionLabel: 'Set up' };
    case 'unavailable':
      return { label: 'Map making is unavailable', busy: false, action: 'open', actionLabel: 'See why' };
    default:
      return { label: newWords ? plural(newWords, 'new word') : schedule.attemptsUsed ? 'Map is up to date' : 'Ready to map', busy: false, action: mapAction };
  }
}
