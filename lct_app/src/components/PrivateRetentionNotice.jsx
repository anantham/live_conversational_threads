import PropTypes from "prop-types";

export default function PrivateRetentionNotice({ id }) {
  return <p id={id} className="mt-3 max-w-[65ch] text-sm leading-6 text-slate-600">Private cloud copies stay until you delete them. Saving privately does not publish them.</p>;
}

PrivateRetentionNotice.propTypes = { id: PropTypes.string.isRequired };
