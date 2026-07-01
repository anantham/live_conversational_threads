import PropTypes from "prop-types";

// Left-rail sub-navigation for the Runtime settings page. One section visible
// at a time. Sections are grouped; a group with an empty title renders no
// header (used for the lone "Overview" entry). On narrow viewports the rail
// collapses to a horizontal, scrollable row of pills.
export default function SettingsRail({ sections, current, onSelect }) {
  let lastGroup = null;

  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1.5 overflow-x-auto pb-1 sm:sticky sm:top-5 sm:flex-col sm:overflow-visible sm:pb-0"
    >
      {sections.map((s) => {
        const showGroup = s.group && s.group !== lastGroup;
        lastGroup = s.group || lastGroup;
        const active = s.id === current;
        return (
          <div key={s.id} className="contents">
            {showGroup ? (
              <div className="hidden px-3 pb-1 pt-3.5 text-[10px] font-medium uppercase tracking-[0.14em] text-gray-400 sm:block">
                {s.group}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              aria-current={active ? "page" : undefined}
              className={`flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition ${
                active
                  ? "bg-white font-semibold text-gray-900 shadow-sm"
                  : "text-gray-600 hover:bg-black/[0.04]"
              }`}
            >
              <span>{s.label}</span>
              {s.hint ? (
                <span className="hidden text-[10px] font-medium text-gray-400 sm:inline">
                  {s.hint}
                </span>
              ) : null}
            </button>
          </div>
        );
      })}
    </nav>
  );
}

SettingsRail.propTypes = {
  sections: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      group: PropTypes.string,
      hint: PropTypes.string,
    }),
  ).isRequired,
  current: PropTypes.string.isRequired,
  onSelect: PropTypes.func.isRequired,
};
