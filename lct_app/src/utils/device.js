/**
 * True on touch-primary devices (phones, tablets): a coarse pointer with no
 * hover. Correctly excludes touch laptops — they keep a fine pointer / hover
 * via the trackpad. Use this to gate behaviour that needs a real user
 * gesture: mobile browsers block getUserMedia (and similar) outside one.
 */
export function isTouchPrimaryDevice() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}
