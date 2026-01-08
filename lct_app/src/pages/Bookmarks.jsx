import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function Bookmarks() {
  const [bookmarks, setBookmarks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [conversations, setConversations] = useState({});

  const navigate = useNavigate();
  const API_URL = import.meta.env.VITE_API_URL || "";

  useEffect(() => {
    loadBookmarks();
    loadConversations();
  }, []);

  const loadBookmarks = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/api/bookmarks`);

      if (!response.ok) {
        throw new Error(`Failed to load bookmarks: ${response.statusText}`);
      }

      const data = await response.json();
      console.log("Loaded bookmarks:", data);
      setBookmarks(data.bookmarks || []);
      setError(null);
    } catch (err) {
      console.error("Error loading bookmarks:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadConversations = async () => {
    try {
      const response = await fetch(`${API_URL}/conversations/`);
      if (!response.ok) return;

      const data = await response.json();
      // Create a map of conversation_id -> conversation_name
      const convMap = {};
      data.forEach((conv) => {
        convMap[conv.file_id] = conv.file_name;
      });
      setConversations(convMap);
    } catch (err) {
      console.error("Error loading conversations:", err);
    }
  };

  const handleDelete = async (bookmarkId) => {
    if (!confirm("Are you sure you want to delete this bookmark?")) {
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/bookmarks/${bookmarkId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        // Remove from local state
        setBookmarks((prev) => prev.filter((b) => b.id !== bookmarkId));
      } else {
        alert("Failed to delete bookmark");
      }
    } catch (err) {
      console.error("Error deleting bookmark:", err);
      alert("Error deleting bookmark");
    }
  };

  const handleNavigateToBookmark = (bookmark) => {
    // Navigate to the conversation page
    // The conversation viewer will need to highlight or scroll to the bookmarked turn
    navigate(`/view/${bookmark.conversation_id}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
        <div className="text-white text-2xl">Loading bookmarks...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-lg max-w-md">
          <h2 className="text-2xl font-bold text-red-600 mb-4">Error</h2>
          <p className="text-gray-700">{error}</p>
          <button
            onClick={() => navigate("/browse")}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Back to Browse
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 text-white">
      {/* Header */}
      <div className="w-full px-6 py-4 bg-white/10 backdrop-blur-sm flex justify-between items-center">
        <h1 className="text-3xl font-bold">My Bookmarks</h1>
        <button
          onClick={() => navigate("/browse")}
          className="px-4 py-2 bg-white text-blue-600 font-semibold rounded-lg shadow hover:bg-blue-100 transition"
        >
          ⬅ Back to Browse
        </button>
      </div>

      {/* Content */}
      <div className="container mx-auto px-6 py-8">
        {bookmarks.length === 0 ? (
          <div className="bg-white/10 backdrop-blur-sm rounded-lg p-8 text-center">
            <h2 className="text-2xl font-semibold mb-4">No bookmarks yet</h2>
            <p className="text-white/80 mb-6">
              Start bookmarking interesting turns in your conversations to save them for later!
            </p>
            <button
              onClick={() => navigate("/browse")}
              className="px-6 py-3 bg-white text-blue-600 font-semibold rounded-lg shadow hover:bg-blue-100 transition"
            >
              Browse Conversations
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {bookmarks.map((bookmark) => (
              <div
                key={bookmark.id}
                className="bg-white rounded-lg shadow-lg p-6 text-gray-800 hover:shadow-xl transition-shadow"
              >
                {/* Conversation Name */}
                <div className="mb-3">
                  <span className="text-xs font-semibold text-blue-600 uppercase">
                    {conversations[bookmark.conversation_id] || "Unknown Conversation"}
                  </span>
                </div>

                {/* Speaker */}
                {bookmark.speaker_id && (
                  <div className="mb-2">
                    <span className="text-sm font-semibold text-gray-600">
                      Speaker: {bookmark.speaker_id}
                    </span>
                  </div>
                )}

                {/* Summary/Preview */}
                <div className="mb-4">
                  <p className="text-sm text-gray-700 line-clamp-3">
                    {bookmark.turn_summary || bookmark.full_text?.substring(0, 150) + "..." || "No preview available"}
                  </p>
                </div>

                {/* Notes */}
                {bookmark.notes && (
                  <div className="mb-4 p-3 bg-yellow-50 rounded border-l-4 border-yellow-400">
                    <p className="text-xs font-semibold text-yellow-800 mb-1">Notes:</p>
                    <p className="text-sm text-gray-700">{bookmark.notes}</p>
                  </div>
                )}

                {/* Timestamp */}
                <div className="mb-4 text-xs text-gray-500">
                  Bookmarked: {new Date(bookmark.created_at).toLocaleDateString()} at{" "}
                  {new Date(bookmark.created_at).toLocaleTimeString()}
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleNavigateToBookmark(bookmark)}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg shadow hover:bg-blue-700 transition text-sm font-semibold"
                  >
                    View in Conversation
                  </button>
                  <button
                    onClick={() => handleDelete(bookmark.id)}
                    className="px-4 py-2 bg-red-500 text-white rounded-lg shadow hover:bg-red-600 transition text-sm font-semibold"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
