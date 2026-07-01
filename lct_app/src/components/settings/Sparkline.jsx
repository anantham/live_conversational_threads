import PropTypes from "prop-types";

// A minimal, dependency-free line sparkline. Higher values sit higher on the
// chart. Used for the connection-latency history in the settings Overview.
export default function Sparkline({ values = [], width = 280, height = 34, className = "" }) {
  if (!values.length) {
    return (
      <div
        className={`text-[11px] text-gray-400 ${className}`}
        style={{ height }}
      >
        gathering samples…
      </div>
    );
  }

  const pad = 3;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const y = (v) => pad + (height - pad * 2) * (1 - (v - min) / range);
  const points = values
    .map((v, i) => `${(pad + i * step).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      className={`block ${className}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`latency history, ${values.length} samples`}
    >
      <polyline fill="none" stroke="#94a3b8" strokeWidth="1.5" points={points} />
    </svg>
  );
}

Sparkline.propTypes = {
  values: PropTypes.arrayOf(PropTypes.number),
  width: PropTypes.number,
  height: PropTypes.number,
  className: PropTypes.string,
};
