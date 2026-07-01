import { useMemo, useState } from "react";
import PropTypes from "prop-types";

import SettingsRail from "../../components/settings/SettingsRail";
import OverviewSection from "../../components/settings/sections/OverviewSection";
import CloudSharingSection from "../../components/settings/sections/CloudSharingSection";
import DiarizationSection from "../../components/settings/sections/DiarizationSection";
import SttSettingsCard from "../../components/settings/SttSettingsCard";
import LlmRoutingCard from "../../components/settings/LlmRoutingCard";
import UserIdentityCard from "../../components/settings/UserIdentityCard";
import HomeBehaviorCard from "../../components/settings/HomeBehaviorCard";
import ArtifactExportCard from "../../components/settings/ArtifactExportCard";
import { useDataProvider } from "../../services/dataProvider";

function SectionIntro({ title, children }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {children ? <p className="mt-1 max-w-2xl text-sm text-gray-600">{children}</p> : null}
    </div>
  );
}

SectionIntro.propTypes = {
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
};

export default function RuntimeSettingsPage() {
  const dataProvider = useDataProvider();
  const isServerless = Boolean(dataProvider.isServerless);
  const [current, setCurrent] = useState("overview");

  // Pipeline order (audio -> who -> meaning). Overview carries the daily glance;
  // the public/serverless view collapses to Overview + Cloud only.
  const sections = useMemo(() => {
    const all = [
      { id: "overview", label: "Overview", group: "", hint: "glance" },
      { id: "stt", label: "Speech-to-text", group: "Capabilities", hint: "daily" },
      { id: "diar", label: "Diarization", group: "Capabilities" },
      { id: "llm", label: "Intelligence", group: "Capabilities", hint: "daily" },
      { id: "cloud", label: "Cloud & sharing", group: "Data & access" },
      { id: "you", label: "You & device", group: "Preferences", hint: "rare" },
      { id: "advanced", label: "Advanced", group: "Preferences", hint: "rare" },
    ];
    return isServerless ? all.filter((s) => s.id === "overview" || s.id === "cloud") : all;
  }, [isServerless]);

  // Guard against a stale selection when the section set changes (e.g. serverless).
  const active = sections.some((s) => s.id === current) ? current : "overview";

  const goTo = (id) => setCurrent(id);

  return (
    <div className="grid items-start gap-6 sm:grid-cols-[212px_minmax(0,1fr)]">
      <SettingsRail sections={sections} current={active} onSelect={goTo} />

      <div className="min-w-0">
        {active === "overview" && (
          <OverviewSection isServerless={isServerless} onEdit={goTo} />
        )}

        {active === "stt" && (
          <div>
            <SectionIntro title="Speech-to-text">
              Turn audio into words. Change the engine and tune its fallbacks, endpoints, and cloud
              keys here. Endpoints resolve on the backend host (your M5), not this browser.
            </SectionIntro>
            <SttSettingsCard />
          </div>
        )}

        {active === "diar" && (
          <div>
            <SectionIntro title="Diarization" />
            <DiarizationSection />
          </div>
        )}

        {active === "llm" && (
          <div>
            <SectionIntro title="Intelligence (LLM)">
              Builds the graph from the transcript. Mode, model, and the provider fallback chain are
              all set here, in one place.
            </SectionIntro>
            <LlmRoutingCard />
          </div>
        )}

        {active === "cloud" && (
          <div>
            <SectionIntro title="Cloud & sharing">
              Where your data is allowed to go. These are two different mechanisms: pick by whether
              you have a backend reachable.
            </SectionIntro>
            <CloudSharingSection isServerless={isServerless} />
          </div>
        )}

        {active === "you" && (
          <div className="space-y-4">
            <SectionIntro title="You & device">
              Personal preferences you set once.
            </SectionIntro>
            <UserIdentityCard />
            <HomeBehaviorCard />
            <ArtifactExportCard />
          </div>
        )}

        {active === "advanced" && (
          <div>
            <SectionIntro title="Advanced">
              Cross-cutting diagnostics and raw configuration. Most per-capability settings live in
              their own section.
            </SectionIntro>
            <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">
              Diagnostics and raw config land here in a later pass.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
