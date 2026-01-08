import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Import() {
  const navigate = useNavigate();
  const [importMethod, setImportMethod] = useState("file"); // file, url, paste
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [conversationName, setConversationName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      // Validate file type
      const validTypes = [".txt", ".pdf"];
      const fileExt = selectedFile.name.substring(
        selectedFile.name.lastIndexOf(".")
      ).toLowerCase();

      if (validTypes.includes(fileExt)) {
        setFile(selectedFile);
        setError(null);
      } else {
        setError(`Invalid file type. Supported: ${validTypes.join(", ")}`);
        setFile(null);
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setUploading(true);

    try {
      let response;

      if (importMethod === "file" && file) {
        // File upload
        const formData = new FormData();
        formData.append("file", file);
        if (conversationName) formData.append("conversation_name", conversationName);

        response = await fetch("http://localhost:8000/api/import/google-meet", {
          method: "POST",
          body: formData,
        });
      } else if (importMethod === "url" && url) {
        // URL import
        response = await fetch("http://localhost:8000/api/import/from-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
            conversation_name: conversationName,
          }),
        });
      } else if (importMethod === "paste" && pastedText) {
        // Pasted text import
        response = await fetch("http://localhost:8000/api/import/from-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: pastedText,
            conversation_name: conversationName,
          }),
        });
      } else {
        setError("Please provide content to import");
        setUploading(false);
        return;
      }

      const data = await response.json();

      if (response.ok) {
        setSuccess(`Import successful! Imported ${data.utterance_count} utterances from ${data.participant_count} participants.`);
        setTimeout(() => {
          navigate(`/conversation/${data.conversation_id}`);
        }, 1500);
      } else {
        setError(data.detail || "Import failed");
      }
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 p-6">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-2xl p-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold text-gray-800">Import Transcript</h1>
          <button
            onClick={() => navigate("/")}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg text-gray-700 transition-colors"
          >
            ← Back
          </button>
        </div>

        {/* Import Method Selection */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setImportMethod("file")}
            className={`flex-1 px-4 py-3 rounded-lg font-medium transition-all ${
              importMethod === "file"
                ? "bg-blue-500 text-white shadow-lg"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            📁 File Upload
          </button>
          <button
            onClick={() => setImportMethod("url")}
            className={`flex-1 px-4 py-3 rounded-lg font-medium transition-all ${
              importMethod === "url"
                ? "bg-blue-500 text-white shadow-lg"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            🔗 URL
          </button>
          <button
            onClick={() => setImportMethod("paste")}
            className={`flex-1 px-4 py-3 rounded-lg font-medium transition-all ${
              importMethod === "paste"
                ? "bg-blue-500 text-white shadow-lg"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            📋 Paste Text
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Conversation Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Conversation Name (Optional)
            </label>
            <input
              type="text"
              value={conversationName}
              onChange={(e) => setConversationName(e.target.value)}
              placeholder="My Meeting Notes"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* File Upload */}
          {importMethod === "file" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select File
              </label>
              <div className="flex items-center gap-4">
                <input
                  type="file"
                  accept=".txt,.pdf"
                  onChange={handleFileChange}
                  className="block w-full text-sm text-gray-500
                    file:mr-4 file:py-2 file:px-4
                    file:rounded-lg file:border-0
                    file:text-sm file:font-semibold
                    file:bg-blue-50 file:text-blue-700
                    hover:file:bg-blue-100 cursor-pointer"
                />
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Supported formats: TXT, PDF (Google Meet transcripts)
              </p>
              {file && (
                <p className="mt-2 text-sm text-green-600">
                  ✓ Selected: {file.name}
                </p>
              )}
            </div>
          )}

          {/* URL Input */}
          {importMethod === "url" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Transcript URL
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/transcript.txt"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              <p className="mt-2 text-xs text-gray-500">
                Enter a URL pointing to a text transcript
              </p>
            </div>
          )}

          {/* Paste Text */}
          {importMethod === "paste" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Paste Transcript
              </label>
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Speaker 1 (00:00:01): Hello everyone...
Speaker 2 (00:00:05): Hi there..."
                rows={12}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                required
              />
              <p className="mt-2 text-xs text-gray-500">
                Expected format: Speaker (timestamp): message
              </p>
            </div>
          )}

          {/* Error/Success Messages */}
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
              {error}
            </div>
          )}
          {success && (
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-green-700">
              {success}
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={uploading}
            className={`w-full px-6 py-3 rounded-lg font-semibold text-white transition-all ${
              uploading
                ? "bg-gray-400 cursor-not-allowed"
                : "bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 shadow-lg hover:shadow-xl"
            }`}
          >
            {uploading ? "Importing..." : "Import Transcript"}
          </button>
        </form>

        {/* Help Section */}
        <div className="mt-8 p-4 bg-blue-50 rounded-lg">
          <h3 className="font-semibold text-blue-900 mb-2">Import Tips:</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• <strong>File:</strong> Upload TXT or PDF (Google Meet format)</li>
            <li>• <strong>URL:</strong> Link to a publicly accessible transcript</li>
            <li>• <strong>Paste:</strong> Copy and paste your transcript text directly</li>
            <li>• Format should include speaker names and timestamps</li>
            <li>• Expected format: <code>Speaker Name (HH:MM:SS): Message</code></li>
          </ul>
        </div>
      </div>
    </div>
  );
}
