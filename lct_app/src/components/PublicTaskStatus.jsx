import PropTypes from "prop-types";

export default function PublicTaskStatus({ activity, elapsed, cancel, loadingLabel = "Loading public conversation" }) {
  if (!activity) return null;
  return <div role="status" aria-live="polite" className="my-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700"><span>{({ list: "Loading public conversations", prepare: "Preparing local file", publish: "Publishing public copy", remove: "Removing public copy", load: loadingLabel })[activity]} · {elapsed}s elapsed · Time remaining unknown</span><button type="button" onClick={cancel} className="min-h-11 font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700">Cancel</button></div>;
}

PublicTaskStatus.propTypes = { activity: PropTypes.string, elapsed: PropTypes.number.isRequired, cancel: PropTypes.func.isRequired, loadingLabel: PropTypes.string };
