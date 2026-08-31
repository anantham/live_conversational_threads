import { useCallback, useEffect, useMemo, useState } from "react";

import {
  initialLiveMobileDeckState,
  initialMobileDeckState,
  reconcileLiveMobileDeckState,
} from "./mobileConversationDeckModel";

function sameEntry(left, right) {
  return left?.kind === right?.kind && left?.id === right?.id;
}

function sameDeckState(left, right) {
  if (!left || !right || left.liveCursor !== right.liveCursor) return false;
  if ((left.trail?.length || 0) !== (right.trail?.length || 0)) return false;
  return (left.trail || []).every((item, index) => sameEntry(item, right.trail[index]));
}

function initialState(model, live) {
  return live ? initialLiveMobileDeckState(model) : initialMobileDeckState(model);
}

export default function useMobileConversationDeckState({
  controlledDeckState,
  live,
  model,
  onDeckStateChange,
}) {
  const computedInitialState = useMemo(() => initialState(model, live), [live, model]);
  const [internalDeckState, setInternalDeckState] = useState(computedInitialState);
  const isControlled = controlledDeckState != null;
  const deckState = isControlled ? controlledDeckState : internalDeckState;

  const commitDeckState = useCallback((nextState) => {
    if (isControlled) {
      onDeckStateChange?.(nextState);
    } else {
      setInternalDeckState(nextState);
    }
  }, [isControlled, onDeckStateChange]);

  useEffect(() => {
    if (isControlled) {
      if (!live) return;
      const reconciled = reconcileLiveMobileDeckState(model, controlledDeckState);
      if (!sameDeckState(reconciled, controlledDeckState)) {
        onDeckStateChange?.(reconciled);
      }
      return;
    }

    setInternalDeckState((previous) => {
      const next = live
        ? reconcileLiveMobileDeckState(model, previous)
        : computedInitialState;
      return sameDeckState(previous, next) ? previous : next;
    });
  }, [computedInitialState, controlledDeckState, isControlled, live, model, onDeckStateChange]);

  return { commitDeckState, deckState };
}
