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
        if (active) setSettingsError("Unable to load STT configuration.");
      });
    return () => {
      active = false;
    };
  }, []);

  return { sttSettings, settingsError, setSettingsError };
};

export { useSttSettings };
