import { useCallback, useEffect } from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";

export default function useUnsavedChangesGuard(when, message) {
  const blocker = useBlocker(Boolean(when));

  useEffect(() => {
    if (blocker.state !== "blocked") {
      return;
    }

    const shouldProceed = window.confirm(message);
    if (shouldProceed) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker, message]);

  const handleBeforeUnload = useCallback(
    (event) => {
      if (!when) {
        return;
      }
      event.preventDefault();
      event.returnValue = message;
    },
    [message, when],
  );

  useBeforeUnload(handleBeforeUnload, { capture: true });
}
