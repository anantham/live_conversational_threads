import PropTypes from "prop-types";
import { ArrowRight } from "lucide-react";

import ByokSessionControl from "../../ByokSessionControl";
import ServerlessModeCard from "../ServerlessModeCard";

// One "where does my data go?" surface. The two paths are genuinely different
// mechanisms (grok review): backend-routed session credentials vs a full
// front-end bypass that swaps the data provider. We frame them together so the
// choice is legible, but keep each mechanism's proven control intact rather
// than merging them into one ambiguous key field.
function DataFlow({ steps }) {
  return (
    <div className="mb-3 inline-flex flex-wrap items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-[11px] text-gray-600">
      {steps.map((s, i) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          {i > 0 ? <ArrowRight className="h-3 w-3 text-gray-400" /> : null}
          {s}
        </span>
      ))}
    </div>
  );
}

DataFlow.propTypes = { steps: PropTypes.arrayOf(PropTypes.string).isRequired };

function Mechanism({ title, blurb, flow, children }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <p className="mb-3 mt-1 max-w-2xl text-xs text-gray-600">{blurb}</p>
      <DataFlow steps={flow} />
      {children}
    </div>
  );
}

Mechanism.propTypes = {
  title: PropTypes.string.isRequired,
  blurb: PropTypes.string.isRequired,
  flow: PropTypes.arrayOf(PropTypes.string).isRequired,
  children: PropTypes.node,
};

export default function CloudSharingSection({ isServerless = false }) {
  return (
    <div className="space-y-4">
      {!isServerless ? (
        <Mechanism
          title="Route through your backend"
          blurb="Your M5 receives the audio, decides routing (local first), and uses this key only if a fallback reaches OpenAI. The backend stays in the path, and the key is session-only."
          flow={["you", "M5 backend", "OpenAI (fallback only)"]}
        >
          <ByokSessionControl />
        </Mechanism>
      ) : null}

      <Mechanism
        title="Run in the browser (Serverless)"
        blurb="Bypass any backend entirely. The app talks straight to OpenAI via Vercel and saves graphs to this browser's local storage. This is what a public visitor uses; no Tailscale needed."
        flow={["browser", "Vercel edge", "OpenAI · stays in this browser"]}
      >
        <ServerlessModeCard />
      </Mechanism>
    </div>
  );
}

CloudSharingSection.propTypes = {
  isServerless: PropTypes.bool,
};
