import PropTypes from "prop-types";
import { useRef } from "react";
import { FileText } from "lucide-react";

export default function ThreadsFileButton({
  className = "",
  disabled = false,
  label = "Open .threads",
  onFileSelected,
  showIcon = true,
}) {
  const inputRef = useRef(null);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={className}
      >
        {showIcon && <FileText aria-hidden="true" size={16} />}
        <span>{label}</span>
      </button>
      {/* No `accept`: mobile downloads commonly identify `.threads` as
          application/octet-stream, so MIME/extension filters disable valid files. */}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onFileSelected(file);
        }}
      />
    </>
  );
}

ThreadsFileButton.propTypes = {
  className: PropTypes.string,
  disabled: PropTypes.bool,
  label: PropTypes.string,
  onFileSelected: PropTypes.func.isRequired,
  showIcon: PropTypes.bool,
};
