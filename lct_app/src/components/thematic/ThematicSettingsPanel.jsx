import { AVAILABLE_MODELS } from "./thematicConstants";

/**
 * Settings dropdown for thematic view — font size, granularity, model selection, regeneration.
 */
export default function ThematicSettingsPanel({
  showSettings,
  setShowSettings,
  settings,
  setSettings,
  onRegenerate,
  isRegenerating,
}) {
  if (!showSettings) return null;

  return (
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
          {AVAILABLE_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} - {model.description}
            </option>
          ))}
        </select>
      </div>

      {/* Regenerate Button */}
      <button
        onClick={onRegenerate}
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
  );
}
