// One bounded, page-memory handoff. Browser history receives only its random ID;
// no artifact, transcript or speaker data is serialized into router state.
let pending = null;

export function stageGeneratedMap(bundle) {
  const id = globalThis.crypto.randomUUID();
  pending = { id, bundle };
  return id;
}

export function readGeneratedMap(id) {
  return typeof id === 'string' && pending?.id === id ? pending.bundle : null;
}

export function releaseGeneratedMap(id) {
  if (pending?.id === id) pending = null;
}
