import ByokSessionControl from "../../components/ByokSessionControl";
import HomeBehaviorCard from "../../components/settings/HomeBehaviorCard";
import InferenceLanes from "../../components/settings/InferenceLanes";
import LlmModelsCard from "../../components/settings/LlmModelsCard";
import LlmRoutingCard from "../../components/settings/LlmRoutingCard";
import SttSettingsCard from "../../components/settings/SttSettingsCard";
import ArtifactExportCard from "../../components/settings/ArtifactExportCard";
import SpeakerVoiceLibraryCard from "../../components/settings/SpeakerVoiceLibraryCard";
import UserIdentityCard from "../../components/settings/UserIdentityCard";

export default function RuntimeSettingsPage() {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xl font-semibold text-gray-800">Runtime</h2>
        <p className="mt-1 max-w-3xl text-sm text-gray-600">
          Pick the active backend for each capability — speech-to-text, diarization, and the LLM —
          with empirical speed, accuracy, and cost. Deep endpoint, fallback, and API-key settings
          stay in the Advanced cards below.
        </p>
      </section>

      <InferenceLanes />

      <div id="advanced-settings" className="space-y-6">
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
            Advanced — endpoints, fallback chains, keys & identity
          </h3>
        </section>
        <UserIdentityCard />
        <HomeBehaviorCard />
        <SttSettingsCard />
        <SpeakerVoiceLibraryCard />
        <ByokSessionControl />
        <LlmRoutingCard />
        <LlmModelsCard />
        <ArtifactExportCard />
      </div>
    </div>
  );
}
