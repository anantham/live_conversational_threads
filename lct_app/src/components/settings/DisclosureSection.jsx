import PropTypes from "prop-types";
import { ChevronDown, ChevronRight } from "lucide-react";

export default function DisclosureSection({
  children,
  description,
  open,
  onToggle,
  summary,
  title,
}) {
  const Icon = open ? ChevronDown : ChevronRight;

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon size={16} className="mt-0.5 flex-none text-gray-500" />
            <p className="text-sm font-semibold text-gray-900">{title}</p>
          </div>
          {description ? (
            <p className="mt-1 text-xs text-gray-500">{description}</p>
          ) : null}
          {summary ? (
            <p className="mt-1 text-xs text-gray-600">{summary}</p>
          ) : null}
        </div>
      </button>

      {open ? <div className="border-t border-gray-200 px-4 py-4">{children}</div> : null}
    </section>
  );
}

DisclosureSection.propTypes = {
  children: PropTypes.node,
  description: PropTypes.string,
  open: PropTypes.bool,
  onToggle: PropTypes.func.isRequired,
  summary: PropTypes.string,
  title: PropTypes.string.isRequired,
};
