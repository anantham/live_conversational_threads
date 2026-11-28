// Vitest setup. Node 25+ defines its own global localStorage/sessionStorage (without a storage file it has
// no setItem). Vitest does not overwrite globals that already exist, so under jsdom the tests would get
// Node's object instead of the browser's. Put jsdom's Web Storage back. No effect on Node 24 or in
// node-environment tests.
const domWindow = globalThis.jsdom?.window;
if (domWindow) {
  for (const name of ['localStorage', 'sessionStorage']) {
    if (globalThis[name] !== domWindow[name]) {
      Object.defineProperty(globalThis, name, { value: domWindow[name], configurable: true, writable: true });
    }
  }
}
