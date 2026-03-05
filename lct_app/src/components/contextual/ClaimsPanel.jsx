import PropTypes from "prop-types";

export default function ClaimsPanel({
  isOpen,
  onClose,
  selectedNode,
  selectedNodeClaims,
  isFactChecking,
  onFactCheck,
  factCheckResults,
}) {
  return (
    <div
      className={`
        fixed top-0 right-0 h-full bg-indigo-100 shadow-2xl z-50 transform transition-transform duration-300 ease-in-out
        p-4 sm:p-6 overflow-y-auto w-full sm:w-1/2 lg:w-1/3
        ${isOpen ? "translate-x-0" : "translate-x-full"}
      `}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-gray-600 hover:text-gray-900 text-2xl"
      >
        &times;
      </button>
      <h2 className="text-xl font-bold mb-4 text-indigo-900">Claims for: {selectedNode}</h2>

      {selectedNodeClaims.length > 0 ? (
        <>
          <ul className="space-y-2 mb-4 list-disc pl-5">
            {selectedNodeClaims.map((claim, index) => (
              <li key={index} className="text-sm text-gray-800">
                {claim}
              </li>
            ))}
          </ul>
          <button
            onClick={onFactCheck}
            disabled={isFactChecking}
            className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg shadow hover:bg-blue-600 disabled:bg-blue-300"
          >
            {isFactChecking ? "Fact-Checking..." : `Fact Check Claims for ${selectedNode}`}
          </button>
        </>
      ) : (
        <p>No claims were found for this node.</p>
      )}

      {isFactChecking && !factCheckResults && (
        <p className="mt-4 text-center">Loading results...</p>
      )}

      {factCheckResults && (
        <div className="mt-6 space-y-4">
          <h3 className="text-lg font-bold text-indigo-800 border-b pb-2 mb-2">
            Fact-Check Results
          </h3>
          {factCheckResults.map((result, index) => (
            <div key={index} className="p-4 rounded-lg bg-white shadow">
              <p className="font-semibold text-gray-800">{result.claim}</p>
              <p
                className={`font-bold text-sm ${
                  result.verdict === "True"
                    ? "text-green-700"
                    : result.verdict === "False"
                    ? "text-red-700"
                    : "text-yellow-600"
                }`}
              >
                Verdict: {result.verdict}
              </p>
              <p className="mt-2 text-sm text-gray-600">{result.explanation}</p>
              {result.citations.length > 0 && (
                <div className="mt-2">
                  <h4 className="font-semibold text-xs text-gray-500 uppercase tracking-wider">
                    Sources:
                  </h4>
                  <ul className="list-disc pl-5 space-y-1 mt-1">
                    {result.citations.map((cite, i) => (
                      <li key={i} className="text-sm">
                        <a
                          href={cite.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          {cite.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

ClaimsPanel.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  selectedNode: PropTypes.string,
  selectedNodeClaims: PropTypes.arrayOf(PropTypes.string).isRequired,
  isFactChecking: PropTypes.bool.isRequired,
  onFactCheck: PropTypes.func.isRequired,
  factCheckResults: PropTypes.array,
};
