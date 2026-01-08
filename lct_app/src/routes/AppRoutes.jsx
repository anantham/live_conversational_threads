import { Routes, Route } from "react-router-dom";
import Home from "../pages/Home";
import NewConversation from "../pages/NewConversation";
import ViewConversation from "../pages/ViewConversation";
import Browse from "../pages/Browse";
import Import from "../pages/Import";
import Analytics from "../pages/Analytics";
import Settings from "../pages/Settings";
import EditHistory from "../pages/EditHistory";
import SimulacraAnalysis from "../pages/SimulacraAnalysis";
import BiasAnalysis from "../pages/BiasAnalysis";
import FrameAnalysis from "../pages/FrameAnalysis";
import CostDashboard from "../pages/CostDashboard";
import Bookmarks from "../pages/Bookmarks";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/new" element={<NewConversation />} />
      <Route path="/browse" element={<Browse />} />
      <Route path="/import" element={<Import />} />
      <Route path="/conversation/:conversationId" element={<ViewConversation />} />
      <Route path="/analytics/:conversationId" element={<Analytics />} />
      <Route path="/edit-history/:conversationId" element={<EditHistory />} />
      <Route path="/simulacra/:conversationId" element={<SimulacraAnalysis />} />
      <Route path="/biases/:conversationId" element={<BiasAnalysis />} />
      <Route path="/frames/:conversationId" element={<FrameAnalysis />} />
      <Route path="/cost-dashboard" element={<CostDashboard />} />
      <Route path="/bookmarks" element={<Bookmarks />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  );
}