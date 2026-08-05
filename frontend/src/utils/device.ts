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

/** Which physical camera to open: front-facing or rear-facing. */
export type FacingMode = 'user' | 'environment';

/**
 * Builds getUserMedia constraints for the camera.
 *
 * Capture is capped on phone-class devices because encoding every frame is the
 * dominant battery/heat cost, and 720p/24 is indistinguishable in a grid tile.
 *
 * `strictFacing` decides how hard we insist on the requested camera:
 *  - false (turning the camera on): `ideal`, so a device that cannot honour the
 *    request still returns *a* camera rather than failing outright.
 *  - true (explicitly switching): `exact`, because the whole point of the action
 *    is to land on the other camera — silently reopening the same one would look
 *    like a broken button.
 *
 * `mobile` is injectable so this stays a pure function and can be tested
 * without a DOM.
 */
export function buildCameraConstraints(
  facingMode: FacingMode,
  strictFacing: boolean,
  mobile: boolean = isMobileDevice()
): MediaStreamConstraints {
  if (!mobile) {
    // Desktops generally expose a single webcam with no meaningful facingMode
    return { video: true };
  }
  return {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: strictFacing ? { exact: facingMode } : { ideal: facingMode }
    }
  };
}
