const KEY = 'lct.conversation_retention.v1';
export function getConversationRetention() {
  try { return localStorage.getItem(KEY) === 'ephemeral' ? 'ephemeral' : 'local'; }
  catch { return 'local'; }
}
export function setConversationRetention(mode) {
  if (!['local', 'ephemeral'].includes(mode)) throw new Error('Unknown conversation saving preference.');
  // Only the preference is stored, never conversation content.
  localStorage.setItem(KEY, mode);
}
