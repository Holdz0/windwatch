// WebRTC call health + recovery rules.
//
// Mobile OSes suspend a backgrounded tab's networking and networks drop, so a
// call's RTCPeerConnection can die at any time. PeerJS cannot renegotiate an
// existing call (it ignores `negotiationneeded`, so restartIce() is a no-op)
// and on ICE 'failed' it closes the connection itself — the only reliable way
// back is to notice the death and place a brand-new call.
//
// If both sides did that they would dial each other at the same moment and
// tear down each other's call (glare). So exactly one side of every pair is
// responsible for placing calls: the one with the smaller peer id. The same
// rule is used for the first call, so it never matters who joined first or
// which socket events were missed during a reconnect.

/** 'disconnected' is often a brief blip; wait this long before calling it dead. */
export const DISCONNECTED_GRACE_MS = 8000;
/** Delays between re-dial attempts; the last value repeats while the peer stays in the room. */
export const RECALL_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export function recallDelay(attempt: number): number {
  return RECALL_BACKOFF_MS[Math.min(attempt, RECALL_BACKOFF_MS.length - 1)];
}

/** Whether this side places (and re-places) the call between the two peers. */
export function shouldInitiateCall(myPeerId: string, theirPeerId: string): boolean {
  return myPeerId < theirPeerId;
}

export interface WatchableCall {
  peerConnection: RTCPeerConnection | null | undefined;
  on(event: 'close' | 'error', cb: (...args: any[]) => void): unknown;
}

export interface CallWatchHandlers {
  /** Fired at most once, when the call can no longer carry media. */
  onDead: (reason: string) => void;
  /** Fired whenever ICE reaches a connected state. */
  onConnected: () => void;
}

/** True when a call's connection is gone for good (used on tab resume). */
export function isCallDead(call: WatchableCall): boolean {
  const pc = call.peerConnection;
  if (!pc) return true;
  return pc.signalingState === 'closed' ||
    pc.iceConnectionState === 'failed' ||
    pc.iceConnectionState === 'closed';
}

/** Watches one call and reports when it dies. */
export function watchCall(call: WatchableCall, handlers: CallWatchHandlers): void {
  let dead = false;
  let disconnectTimer: number | null = null;

  const clearTimer = () => {
    if (disconnectTimer !== null) {
      window.clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };

  const die = (reason: string) => {
    if (dead) return;
    dead = true;
    clearTimer();
    handlers.onDead(reason);
  };

  call.on('close', () => die('closed'));
  call.on('error', (err: any) => die(`error: ${err?.type || err}`));

  const pc = call.peerConnection;
  if (!pc) return;

  pc.addEventListener('iceconnectionstatechange', () => {
    const state = pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      clearTimer();
      handlers.onConnected();
    } else if (state === 'failed') {
      die('ice failed');
    } else if (state === 'disconnected' && disconnectTimer === null) {
      disconnectTimer = window.setTimeout(() => {
        disconnectTimer = null;
        if (pc.iceConnectionState === 'disconnected') die('ice disconnected');
      }, DISCONNECTED_GRACE_MS);
    }
  });
}
