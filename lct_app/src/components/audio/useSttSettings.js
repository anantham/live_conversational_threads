import { useEffect, useState } from "react";

import { getSttSettings } from "../../services/sttSettingsApi";

const useSttSettings = () => {
  const [sttSettings, setSttSettings] = useState(null);
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    let active = true;
    getSttSettings()
      .then((config) => {
        if (active) setSttSettings(config);
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
