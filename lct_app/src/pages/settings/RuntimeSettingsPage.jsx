import LlmModelsCard from "../../components/settings/LlmModelsCard";
import LlmRoutingCard from "../../components/settings/LlmRoutingCard";
import SttSettingsCard from "../../components/settings/SttSettingsCard";

export default function RuntimeSettingsPage() {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xl font-semibold text-gray-800">Runtime</h2>
        <p className="mt-1 max-w-3xl text-sm text-gray-600">
          Configure the live pipeline in execution order: speech-to-text first, then graph routing,
          then model defaults. Everything else stays behind progressive disclosure.
        </p>
      </section>

      <div className="space-y-6">
        <SttSettingsCard />
        <LlmRoutingCard />
        <LlmModelsCard />
      </div>
    </div>
  );
}
