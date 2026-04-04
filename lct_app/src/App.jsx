import { BrowserRouter } from "react-router-dom";
import AppRoutes from "./routes/AppRoutes";
import { ByokProvider } from "./contexts/ByokContext.jsx";
import { UploadProvider } from "./contexts/UploadContext";
import UploadToast from "./components/upload/UploadToast";

export default function App() {
  return (
    <BrowserRouter>
      <ByokProvider>
        <UploadProvider>
          <AppRoutes />
          <UploadToast />
        </UploadProvider>
      </ByokProvider>
    </BrowserRouter>
  );
}
