import { DataProvider } from './dataProvider';
import { API_BASE_URL, apiHeaders } from './apiClient';

import * as analyticsApi from './analyticsApi';
import * as artifactSettingsApi from './artifactSettingsApi';
import * as audioRecoveryApi from './audioRecoveryApi';
import * as backendCatalogApi from './backendCatalogApi';
import * as biasApi from './biasApi';
import * as byokApi from './byokApi';
import * as consumptionApi from './consumptionApi';
import * as conversationDiagnosticsApi from './conversationDiagnosticsApi';
import * as cruxApi from './cruxApi';
import * as editHistoryApi from './editHistoryApi';
import * as frameApi from './frameApi';
import * as graphApi from './graphApi';
import * as llmSettingsApi from './llmSettingsApi';
import * as participantsApi from './participantsApi';
import * as prayerCardsApi from './prayerCardsApi';
import * as promptsApi from './promptsApi';
import * as simulacraApi from './simulacraApi';
import * as speakerNamingApi from './speakerNamingApi';
import * as sttSettingsApi from './sttSettingsApi';

export class BackendDataProvider extends DataProvider {
  constructor() {
    super();
    this._analytics = analyticsApi;
    this._artifactSettings = artifactSettingsApi;
    this._audioRecovery = audioRecoveryApi;
    this._backendCatalog = backendCatalogApi;
    this._bias = biasApi;
    this._byok = byokApi;
    this._consumption = consumptionApi;
    this._conversationDiagnostics = conversationDiagnosticsApi;
    this._crux = cruxApi;
    this._editHistory = editHistoryApi;
    this._frame = frameApi;
    this._graph = graphApi;
    this._llmSettings = llmSettingsApi;
    this._participants = participantsApi;
    this._prayerCards = prayerCardsApi;
    this._prompts = promptsApi;
    this._simulacra = simulacraApi;
    this._speakerNaming = speakerNamingApi;
    this._sttSettings = sttSettingsApi;

    // High-level operations that previously bypassed service modules
    this._conversations = {
      fetchThreadsData: async (id) => {
        const resp = await fetch(`${API_BASE_URL}/api/conversations/${id}/threads`);
        return resp.json();
      },
      fetchNext: async (nextUrl, options = {}) => {
        const { headers, ...rest } = options;
        return fetch(`${API_BASE_URL}${nextUrl}`, {
          method: "POST",
          ...rest,
          headers: { ...apiHeaders(), ...(headers || {}) },
        });
      },
      fetchSimulacra: async (id) => {
        const resp = await fetch(`${API_BASE_URL}/api/conversations/${id}/simulacra`);
        return resp.json();
      },
      reprocess: async (id, options = {}) => {
        return fetch(`${API_BASE_URL}/api/conversations/${id}/reprocess`, {
          method: "POST",
          ...options
        });
      },
      fetchThreadsFile: async (src) => {
        return fetch(src);
      },
      fetchRevisions: async (id, options = {}) => {
        return fetch(`${API_BASE_URL}/api/conversations/${id}/revisions`, options);
      },
      approveRevision: async (id, revisionId, options = {}) => {
        return fetch(`${API_BASE_URL}/api/conversations/${id}/revisions/${revisionId}/approve`, {
          method: "POST",
          ...options
        });
      },
      rejectRevision: async (id, revisionId, options = {}) => {
        return fetch(`${API_BASE_URL}/api/conversations/${id}/revisions/${revisionId}/reject`, {
          method: "POST",
          ...options
        });
      },
      fetchThreadsExport: async (id, options = {}) => {
        return fetch(`${API_BASE_URL}/api/conversations/${id}/threads-export`, options);
      }
    };

    this._import = {
      processFile: async (formData) => {
        return fetch(`${API_BASE_URL}/api/import/process-file`, {
          method: "POST",
          headers: apiHeaders(),
          body: formData
        });
      }
    };

    this._audio = {
      uploadChunk: async (url, chunk, options = {}) => {
        return fetch(url, { method: "POST", ...options, body: chunk });
      },
      completeUpload: async (url, options = {}) => {
        return fetch(url, { method: "POST", ...options });
      },
      uploadEdgeStt: async (url, formData, options = {}) => {
        return fetch(url, { method: "POST", ...options, body: formData });
      }
    };

    this._share = {
      fetchShared: async (token) => {
        return fetch(`${API_BASE_URL}/api/share/${encodeURIComponent(token)}`, {
          headers: apiHeaders()
        });
      }
    };

    this._subjectReview = {
      start: async (id, options = {}) => {
        return fetch(`${API_BASE_URL}/api/conversations/${id}/subject_review/start`, {
          method: "POST",
          ...options
        });
      },
      submit: async (id, payload, options = {}) => {
        return fetch(`${API_BASE_URL}/api/conversations/${id}/subject_review/submit`, {
          method: "POST",
          ...options,
          body: JSON.stringify(payload)
        });
      },
      fetchReview: async (token, options = {}) => {
        return fetch(`${API_BASE_URL}/api/subject-review/${encodeURIComponent(token)}`, options);
      },
      submitReview: async (token, payload, options = {}) => {
        return fetch(`${API_BASE_URL}/api/subject-review/${encodeURIComponent(token)}/decisions`, {
          method: "POST",
          ...options,
          body: JSON.stringify(payload)
        });
      }
    };
  }

  get analytics() { return this._analytics; }
  get artifactSettings() { return this._artifactSettings; }
  get audioRecovery() { return this._audioRecovery; }
  get backendCatalog() { return this._backendCatalog; }
  get bias() { return this._bias; }
  get byok() { return this._byok; }
  get consumption() { return this._consumption; }
  get conversationDiagnostics() { return this._conversationDiagnostics; }
  get crux() { return this._crux; }
  get editHistory() { return this._editHistory; }
  get frame() { return this._frame; }
  get graph() { return this._graph; }
  get llmSettings() { return this._llmSettings; }
  get participants() { return this._participants; }
  get prayerCards() { return this._prayerCards; }
  get prompts() { return this._prompts; }
  get simulacra() { return this._simulacra; }
  get speakerNaming() { return this._speakerNaming; }
  get sttSettings() { return this._sttSettings; }

  get conversations() { return this._conversations; }
  get import() { return this._import; }
  get audio() { return this._audio; }
  get share() { return this._share; }
  get subjectReview() { return this._subjectReview; }
}
