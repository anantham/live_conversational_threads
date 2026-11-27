import PropTypes from "prop-types";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

// Test intent (critique 2026-11-25 issue 5; owner ruling 2026-11-26):
// - Every standalone page opens the same way: a way back on the left, optional page links on the
//   right, then the title, a short description and any page actions above one hairline.
// - The title is the page's only heading at the top: no eyebrow label above it (craft floor ban).
// - Embedded use (a page shown inside another, e.g. a library tab) drops the way back and uses a
//   smaller h2, because the surrounding page already provides both and owns the page's h1. Links
//   a caller still passes are kept.
// - The title block is a plain div, not <header>: outside <main> a header becomes a site-wide
//   banner landmark, and this is one page's title.

const backClass = "inline-flex min-h-11 items-center gap-2 text-sm text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700";

export const pageLinkClass = "inline-flex min-h-11 items-center text-sm text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700";

export default function PageHeader({ title, description, back = { to: "/", label: "Home" }, links, actions, embedded = false, children }) {
  const backControl = back && (typeof back.onClick === "function"
    ? <button type="button" onClick={back.onClick} className={backClass}><ArrowLeft size={16} aria-hidden="true" />{back.label}</button>
    : <Link to={back.to} className={backClass}><ArrowLeft size={16} aria-hidden="true" />{back.label}</Link>);
  return <>
    {((!embedded && backControl) || links) && <nav aria-label={embedded ? (typeof title === "string" ? `${title} links` : "Section links") : "Page"} className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1">
      {(!embedded && backControl) || <span />}
      {links && <div className="flex flex-wrap items-center gap-x-5">{links}</div>}
    </nav>}
    <div data-page-header="" className={`flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 ${embedded ? "pb-4" : "mt-6 pb-6"}`}>
      <div className="min-w-0">
        {embedded
          ? <h2 className="text-xl font-semibold tracking-[-0.02em] text-slate-900">{title}</h2>
          : <h1 className="text-3xl font-semibold tracking-[-0.03em] text-slate-900">{title}</h1>}
        {description && <p className="mt-2 max-w-[65ch] text-sm leading-6 text-slate-600">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  </>;
}

// A way back needs somewhere to go: a destination or a click handler.
function backShape(props, propName, componentName) {
  const back = props[propName];
  if (back === undefined || back === null || back === false) return null;
  if (typeof back !== "object") return new Error(`${componentName}: ${propName} must be false, null or an object.`);
  if (typeof back.label !== "string" || !back.label) return new Error(`${componentName}: ${propName}.label is required.`);
  if (back.onClick !== undefined && typeof back.onClick !== "function") return new Error(`${componentName}: ${propName}.onClick must be a function.`);
  if (back.to !== undefined && (typeof back.to !== "string" || !back.to)) return new Error(`${componentName}: ${propName}.to must be a non-empty path.`);
  if (back.onClick === undefined && back.to === undefined) return new Error(`${componentName}: ${propName} needs a "to" destination or an onClick handler.`);
  return null;
}

PageHeader.propTypes = {
  title: PropTypes.node.isRequired,
  description: PropTypes.node,
  back: backShape,
  links: PropTypes.node,
  actions: PropTypes.node,
  embedded: PropTypes.bool,
  children: PropTypes.node,
};
