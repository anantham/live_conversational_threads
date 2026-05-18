import { useCallback } from "react";
import { useBeforeUnload } from "react-router-dom";

/**
 * Warn on tab close / browser reload when there are unsaved edits.
 *
 * Previously this hook also called ``useBlocker`` to intercept in-app
 * navigation. That throws "useBlocker must be used within a data router"
 * under the standard ``BrowserRouter`` (the app's setup), crashing
 * /settings/prompts on mount. To restore in-app blocking we'd have to
 * migrate the whole app to ``createBrowserRouter``, which is a much
 * larger change. The browser-level ``beforeunload`` guard handles the
 * most common case (closing the tab); React Router clicks just lose the
 * draft, same as 90% of forms in the wild.
 */
export default function useUnsavedChangesGuard(when, message) {
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
