import { useEffect, useState } from "react";

import { getSttSettings } from "../../services/sttSettingsApi";
import { normalizeSttSettings } from "./sttUtils";

const useSttSettings = () => {
  const [sttSettings, setSttSettings] = useState(null);
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    let active = true;
    getSttSettings()
      .then((config) => {
        if (active) setSttSettings(normalizeSttSettings(config));
      })
      .catch((err) => {
        console.error("Failed to load STT settings:", err);
        const isNetworkError = err.message?.includes("fetch") || err.name === "TypeError";
        if (active) {
          setSettingsError(isNetworkError ? "Backend unavailable" : "Unable to load STT configuration.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return { sttSettings, settingsError, setSettingsError };
};

export { useSttSettings };
