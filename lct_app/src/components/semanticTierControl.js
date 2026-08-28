import { resolveRequestedSemanticLevel } from "./graphNormalization";

/**
 * Camera animation is an output of a semantic-tier change, never a second
 * semantic input. Only a settled user gesture may choose another unlocked
 * tier; fitView/setViewport updates retain the current tier.
 */
export function semanticLevelAfterViewportMove({
  currentLevel,
  viewportZoom,
  previousViewportZoom,
  programmatic = false,
  zoomEpsilon = 0.001,
}) {
  if (programmatic) return currentLevel;
  const zoom = Number(viewportZoom);
  const previousZoom = Number(previousViewportZoom);
  if (!Number.isFinite(zoom) || !Number.isFinite(previousZoom)) return currentLevel;
  const epsilon = Number.isFinite(Number(zoomEpsilon)) ? Math.abs(Number(zoomEpsilon)) : 0.001;
  if (Math.abs(zoom - previousZoom) <= epsilon) return currentLevel;
  return resolveRequestedSemanticLevel(zoom);
}
