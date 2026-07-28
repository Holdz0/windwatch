// WebRTC connection recovery.
//
// Mobile OSes suspend a backgrounded tab's networking (switching apps, screen
// off) to save battery — that is a browser/OS policy no web page can opt out
// of. But WebRTC also does NOT recover on its own once networking resumes: an
// RTCPeerConnection left in 'disconnected'/'failed' needs an explicit ICE
// restart, and one the browser fully closed needs the call re-established
// from scratch. Left unhandled, backgrounding the tab during a call silently
// and permanently drops that participant's audio/video.
//
// Factored out of Room.tsx so the recovery state machine can be unit tested
// without a real RTCPeerConnection or browser.

export interface RecoverablePeerConnection {
  connectionState: string;
  addEventListener(type: 'connectionstatechange', cb: () => void): void;
  restartIce?: () => void;
}

export interface RecoverableCall {
  peerConnection: RecoverablePeerConnection | null | undefined;
}

export interface RecoveryCallbacks {
  /** Re-establishes the call to this socket from scratch (fresh offer/answer). */
  recreateCall: (socketId: string) => void;
  /** False once `call` has been superseded by a newer call for the same socketId. */
  isCurrentCall: (socketId: string, call: RecoverableCall) => boolean;
  /** False once the peer has actually left the room — don't resurrect calls to ghosts. */
  isRoomMember: (socketId: string) => boolean;
  onLog?: (msg: string) => void;
}

// Minimal subset of the timer API needed, injectable so tests can run without
// real delays.
export interface TimerLike {
  setTimeout: (fn: () => void, ms: number) => unknown;
}

const defaultTimers: TimerLike = { setTimeout: (fn, ms) => setTimeout(fn, ms) };

/** 'disconnected' is often a brief blip; wait this long before acting on it. */
export const DISCONNECTED_GRACE_MS = 4000;
/** Minimum time between restartIce() attempts on the same call. */
export const RESTART_COOLDOWN_MS = 6000;
/** After this many failed restarts, stop retrying ICE and rebuild the call instead. */
export const MAX_RESTART_ATTEMPTS_BEFORE_RECREATE = 2;

/**
 * Attaches recovery behaviour to one call's RTCPeerConnection:
 *  - 'failed' immediately attempts an ICE restart, escalating to a full
 *    recreate after repeated failures (or immediately if restartIce() isn't
 *    supported by this browser).
 *  - 'disconnected' waits out a grace period (it usually self-heals) before
 *    doing anything.
 *  - 'closed' unexpectedly (not via our own intentional cleanup) rebuilds the
 *    call, but only if the peer is still actually in the room.
 *  - 'connected' resets the attempt counter, so a later hiccup gets a full
 *    retry budget rather than an accumulated one.
 */
export function monitorCallConnection(
  socketId: string,
  call: RecoverableCall,
  cb: RecoveryCallbacks,
  timers: TimerLike = defaultTimers
): void {
  const pc = call.peerConnection;
  if (!pc) return;

  let recovering = false;
  let attempts = 0;

  const tryRestartIce = () => {
    if (recovering) return;
    recovering = true;
    attempts++;
    cb.onLog?.(`${socketId}: connection ${pc.connectionState}, attempting ICE restart (try ${attempts})`);
    try {
      if (typeof pc.restartIce === 'function') {
        pc.restartIce();
      } else {
        throw new Error('restartIce unsupported by this browser');
      }
    } catch (err) {
      cb.onLog?.(`ICE restart unavailable, re-establishing call instead: ${err}`);
      cb.recreateCall(socketId);
    }
    timers.setTimeout(() => { recovering = false; }, RESTART_COOLDOWN_MS);
  };

  const onStateChange = () => {
    // Superseded by a newer call for the same peer — stop reacting on this one
    if (!cb.isCurrentCall(socketId, call)) return;

    const state = pc.connectionState;
    if (state === 'connected') {
      attempts = 0;
    } else if (state === 'failed') {
      if (attempts >= MAX_RESTART_ATTEMPTS_BEFORE_RECREATE) {
        cb.recreateCall(socketId);
      } else {
        tryRestartIce();
      }
    } else if (state === 'disconnected') {
      timers.setTimeout(() => {
        if (cb.isCurrentCall(socketId, call) && pc.connectionState === 'disconnected') {
          tryRestartIce();
        }
      }, DISCONNECTED_GRACE_MS);
    } else if (state === 'closed') {
      if (cb.isRoomMember(socketId)) {
        cb.recreateCall(socketId);
      }
    }
  };

  pc.addEventListener('connectionstatechange', onStateChange);
}

/**
 * Proactive check run when the tab becomes visible again. `connectionstatechange`
 * events can be delayed or coalesced while the tab's JS was frozen in the
 * background, so every active call is re-checked directly rather than waiting
 * on events that may arrive late or not at all.
 */
export function checkCallsOnResume(
  activeCalls: Record<string, RecoverableCall>,
  cb: RecoveryCallbacks
): void {
  Object.entries(activeCalls).forEach(([socketId, call]) => {
    const pc = call.peerConnection;
    if (!pc) return;

    if (pc.connectionState === 'closed') {
      if (cb.isRoomMember(socketId)) cb.recreateCall(socketId);
    } else if (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting') {
      if (typeof pc.restartIce === 'function') {
        cb.onLog?.(`Tab resumed; nudging ${socketId} (${pc.connectionState})`);
        pc.restartIce();
      }
    }
  });
}
