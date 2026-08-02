// Device capability detection.
//
// Deliberately feature/capability based rather than user-agent sniffing: a
// coarse pointer plus a small viewport is what actually predicts the things we
// care about (limited encode budget, battery constraints, touch interaction),
// and it stays correct for tablets, foldables and desktop touch screens without
// a UA table to maintain.

/** True on phone-class devices: touch-primary AND a physically small screen. */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  // Compare against the shorter edge so the answer doesn't flip on rotation
  const shortEdge = Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0);
  return coarsePointer && shortEdge > 0 && shortEdge <= 820;
}
