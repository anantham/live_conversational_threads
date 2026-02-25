import { useNavigate } from "react-router-dom";
import { Mic, FolderOpen, FileUp, Bookmark, BarChart3, Settings } from "lucide-react";

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center h-[100dvh] w-screen bg-[#fafafa] font-sans">
      {/* Title */}
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-10">
        Live Conversational Threads
      </p>

      {/* Primary actions */}
      <div className="flex items-center gap-6 mb-12">
        <button
          onClick={() => navigate("/new")}
          className="flex flex-col items-center gap-2 group"
        >
          <span className="w-14 h-14 flex items-center justify-center rounded-full bg-gray-800 text-white group-hover:bg-gray-700 transition">
            <Mic size={22} />
          </span>
          <span className="text-xs text-gray-500 group-hover:text-gray-700 transition">New</span>
        </button>

        <button
          onClick={() => navigate("/browse")}
          className="flex flex-col items-center gap-2 group"
        >
          <span className="w-14 h-14 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-gray-200 text-gray-500 group-hover:text-gray-700 group-hover:border-gray-300 transition">
            <FolderOpen size={22} />
          </span>
          <span className="text-xs text-gray-500 group-hover:text-gray-700 transition">Browse</span>
        </button>
      </div>

      {/* Secondary actions */}
      <div className="flex items-center gap-5">
        <button
          onClick={() => navigate("/import")}
          className="flex flex-col items-center gap-1.5 group"
        >
          <span className="w-9 h-9 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-gray-150 text-gray-400 group-hover:text-gray-600 group-hover:border-gray-300 transition">
            <FileUp size={16} />
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-gray-600 transition">Import</span>
        </button>

        <button
          onClick={() => navigate("/bookmarks")}
          className="flex flex-col items-center gap-1.5 group"
        >
          <span className="w-9 h-9 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-gray-150 text-gray-400 group-hover:text-gray-600 group-hover:border-gray-300 transition">
            <Bookmark size={16} />
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-gray-600 transition">Bookmarks</span>
        </button>

        <button
          onClick={() => navigate("/cost-dashboard")}
          className="flex flex-col items-center gap-1.5 group"
        >
          <span className="w-9 h-9 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-gray-150 text-gray-400 group-hover:text-gray-600 group-hover:border-gray-300 transition">
            <BarChart3 size={16} />
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-gray-600 transition">Costs</span>
        </button>

        <button
          onClick={() => navigate("/settings")}
          className="flex flex-col items-center gap-1.5 group"
        >
          <span className="w-9 h-9 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-gray-150 text-gray-400 group-hover:text-gray-600 group-hover:border-gray-300 transition">
            <Settings size={16} />
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-gray-600 transition">Settings</span>
        </button>
      </div>
    </div>
  );
}