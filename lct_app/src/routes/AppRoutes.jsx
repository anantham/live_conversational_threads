import { Navigate, Route, Routes } from "react-router-dom";
import Home from "../pages/Home";
import NewConversation from "../pages/NewConversation";
import JoinMeeting from "../pages/JoinMeeting";
import MeetingView from "../pages/MeetingView";
import ViewConversation from "../pages/ViewConversation";
import ShareConversation from "../pages/ShareConversation";
import SubjectReview from "../pages/SubjectReview";
import ThreadsViewer from "../pages/ThreadsViewer";
import Browse from "../pages/Browse";
import Import from "../pages/Import";
import Analytics from "../pages/Analytics";
import EditHistory from "../pages/EditHistory";
import SimulacraAnalysis from "../pages/SimulacraAnalysis";
import BiasAnalysis from "../pages/BiasAnalysis";
import FrameAnalysis from "../pages/FrameAnalysis";
import CruxAnalysis from "../pages/CruxAnalysis";
import ClaimsView from "../pages/ClaimsView";
import DebateReport from "../pages/DebateReport";
import DebateShared from "../pages/DebateShared";
import CostDashboard from "../pages/CostDashboard";
import Bookmarks from "../pages/Bookmarks";
import PromptLibraryPage from "../pages/settings/PromptLibraryPage";
import RuntimeSettingsPage from "../pages/settings/RuntimeSettingsPage";
import SettingsLayout from "../pages/settings/SettingsLayout";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/new" element={<NewConversation />} />
      {/* Attendee meeting bot: paste a Meet link, then watch the live graph. */}
      <Route path="/meeting" element={<JoinMeeting />} />
      <Route path="/meeting/:conversationId" element={<MeetingView />} />
      <Route path="/browse" element={<Browse />} />
      <Route path="/import" element={<Import />} />
      <Route path="/conversation/:conversationId" element={<ViewConversation />} />
      {/* Public read-only share. AUTH_TOKEN does not apply to recipients;
          /share/<token> renders the conversation in read-only mode after
          per-share Google ID verification (when the share is restricted). */}
      <Route path="/share/:token" element={<ShareConversation />} />
      {/* Subject-side privacy review (ADR-039 P2). Public like /share: the
          subject (an external person) has only a Google ID token, no AUTH_TOKEN.
          Email-gated server-side to exactly subject_email. */}
      <Route path="/subject-review/:token" element={<SubjectReview />} />
      {/* Static, server-free .threads viewer (ADR-036). Exempt from the App.jsx
          backend gate; makes zero /api/ calls — renders a self-contained file. */}
      <Route path="/view" element={<ThreadsViewer />} />
      <Route path="/analytics/:conversationId" element={<Analytics />} />
      <Route path="/edit-history/:conversationId" element={<EditHistory />} />
      <Route path="/simulacra/:conversationId" element={<SimulacraAnalysis />} />
      <Route path="/biases/:conversationId" element={<BiasAnalysis />} />
      <Route path="/frames/:conversationId" element={<FrameAnalysis />} />
      <Route path="/cruxes/:conversationId" element={<CruxAnalysis />} />
      <Route path="/claims/:conversationId" element={<ClaimsView />} />
      <Route path="/debate/s" element={<DebateShared />} />
      <Route path="/debate/:conversationId" element={<DebateReport />} />
      <Route path="/cost-dashboard" element={<CostDashboard />} />
      <Route path="/bookmarks" element={<Bookmarks />} />
      <Route path="/settings" element={<SettingsLayout />}>
        <Route index element={<Navigate replace to="runtime" />} />
        <Route path="runtime" element={<RuntimeSettingsPage />} />
        <Route path="prompts" element={<PromptLibraryPage />} />
      </Route>
    </Routes>
  );
}
