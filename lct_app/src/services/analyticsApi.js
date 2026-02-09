/**
 * API Client for Speaker Analytics Service
 *
 * Connects to the FastAPI backend analytics endpoints (Week 8).
 * Handles fetching speaker statistics, timeline, and role detection.
 */

import { apiFetch } from './apiClient';

/**
 * Fetch complete analytics for a conversation
 * @param {string} conversationId - UUID of the conversation
 * @returns {Promise<Object>} Analytics data with speakers, timeline, roles, and summary
 */
export async function fetchConversationAnalytics(conversationId) {
  const url = `/api/analytics/conversations/${conversationId}/analytics`;

  const response = await apiFetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Failed to fetch analytics: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetch statistics for a specific speaker
 * @param {string} conversationId - UUID of the conversation
 * @param {string} speakerId - ID of the speaker
 * @returns {Promise<Object>} Speaker statistics
 */
export async function fetchSpeakerStats(conversationId, speakerId) {
  const url = `/api/analytics/conversations/${conversationId}/speakers/${speakerId}`;

  const response = await apiFetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Failed to fetch speaker stats: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetch speaker timeline for a conversation
 * @param {string} conversationId - UUID of the conversation
 * @returns {Promise<Array>} Timeline segments
 */
export async function fetchSpeakerTimeline(conversationId) {
  const url = `/api/analytics/conversations/${conversationId}/timeline`;

  const response = await apiFetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Failed to fetch timeline: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetch speaker roles for a conversation
 * @param {string} conversationId - UUID of the conversation
 * @returns {Promise<Object>} Role assignments (speaker_id -> role)
 */
export async function fetchSpeakerRoles(conversationId) {
  const url = `/api/analytics/conversations/${conversationId}/roles`;

  const response = await apiFetch(url);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Failed to fetch roles: ${response.statusText}`);
  }

  return await response.json();
}
