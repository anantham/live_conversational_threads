import { NavLink, Outlet, useNavigate } from "react-router-dom";
import PageHeader from "../../components/PageHeader";

// The Landscape's pill control, shared with the Graph's level tabs (critique 2026-11-25 issue 5).
const navLinkClassName = ({ isActive }) =>
  `inline-flex min-h-10 items-center rounded-full px-4 text-sm transition-colors ${
    isActive
      ? "bg-white font-medium text-slate-900 shadow-xs"
      : "text-slate-600 hover:text-slate-900"
  }`;

export default function SettingsLayout() {
  const navigate = useNavigate();
  const sites = import.meta.env.VITE_SITES_MODE === "true";

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] px-4 pb-24 pt-8 font-sans text-slate-800 sm:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <PageHeader title="Settings" back={{ onClick: () => navigate(-1), label: "Back" }}
            description={sites ? 'Manage transcription, intelligence, and the prompts used to generate conversation maps.'
              : 'Keep runtime configuration compact, and open details only when you need them.'}
            actions={<nav aria-label="Settings pages" className="inline-flex items-center rounded-full bg-stone-200/70 p-0.5">
              <NavLink end to="/settings/runtime" className={navLinkClassName}>
                {sites ? "Providers" : "Runtime"}
              </NavLink>
              <NavLink to="/settings/prompts" className={navLinkClassName}>
                Prompts
              </NavLink>
            </nav>} />
        </div>

        <Outlet />
      </div>
    </div>
  );
}
