import { NavLink, Outlet, useNavigate } from "react-router-dom";

const navLinkClassName = ({ isActive }) =>
  `rounded-full px-4 py-2 text-sm font-medium transition ${
    isActive
      ? "bg-gray-900 text-white shadow-sm"
      : "bg-white text-gray-600 hover:bg-gray-100 hover:text-gray-800"
  }`;

export default function SettingsLayout() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl space-y-8">
        <div className="space-y-4">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center text-gray-500 transition hover:text-gray-900"
            type="button"
          >
            ← Back
          </button>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-800">Settings</h1>
              <p className="mt-1 text-gray-600">
                Keep runtime configuration compact, and open details only when you need them.
              </p>
            </div>

            <nav className="flex items-center gap-2 rounded-full border border-gray-200 bg-gray-100 p-1">
              <NavLink end to="/settings/runtime" className={navLinkClassName}>
                Runtime
              </NavLink>
              <NavLink to="/settings/prompts" className={navLinkClassName}>
                Prompts
              </NavLink>
            </nav>
          </div>
        </div>

        <Outlet />
      </div>
    </div>
  );
}
