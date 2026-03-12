import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ActiveConfigSummary from '../components/ActiveConfigSummary';
import LlmProvidersPanel from '../components/LlmProvidersPanel';
import SttSettingsPanel from '../components/SttSettingsPanel';
import PromptEditorPanel from '../components/PromptEditorPanel';
import DiagnosticsPanel from '../components/DiagnosticsPanel';

const TABS = [
  { id: 'llm', label: 'LLM Providers' },
  { id: 'speech', label: 'Speech' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'diag', label: 'Diagnostics' },
];

export default function Settings() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('llm');

  // Incremented when ActiveConfigSummary saves, forcing tab panels
  // to remount with fresh data from the backend.
  const [configVersion, setConfigVersion] = useState(0);
  const handleConfigChange = useCallback(() => {
    setConfigVersion((v) => v + 1);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => navigate(-1)}
            className="text-blue-600 hover:text-blue-800 mb-2 flex items-center"
          >
            ← Back
          </button>
          <h1 className="text-3xl font-bold text-gray-800">Settings</h1>
          <p className="text-gray-600 mt-1">Configure LLM providers, speech-to-text, and prompts.</p>
        </div>

        {/* Active config summary — glanceable, always visible */}
        <ActiveConfigSummary onConfigChange={handleConfigChange} />

        {/* Tab Bar */}
        <div className="flex border-b border-gray-200">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={
                activeTab === tab.id
                  ? 'px-4 py-2 text-blue-600 border-b-2 border-blue-600 font-medium -mb-px'
                  : 'px-4 py-2 text-gray-500 hover:text-gray-700'
              }
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content — always mounted, hidden via CSS to preserve draft state.
            key={configVersion} on LLM/STT panels forces remount after summary saves,
            so they reload fresh data and don't overwrite the summary's changes. */}
        <div hidden={activeTab !== 'llm'}>
          <LlmProvidersPanel key={`llm-${configVersion}`} />
        </div>

        <div hidden={activeTab !== 'speech'}>
          <SttSettingsPanel key={`stt-${configVersion}`} />
        </div>

        <div hidden={activeTab !== 'prompts'}>
          <PromptEditorPanel />
        </div>

        <div hidden={activeTab !== 'diag'}>
          <DiagnosticsPanel key={`diag-${configVersion}`} />
        </div>
      </div>
    </div>
  );
}
