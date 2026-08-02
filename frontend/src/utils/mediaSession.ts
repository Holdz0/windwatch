// Media Session integration.
//
// Publishes the call to the OS so it shows up where a native app would: the
// Android lock screen, the notification shade and (on desktop) the browser's
// media hub. Beyond looking native, this is genuinely useful — the mic can be
// toggled and the call ended without unlocking the phone or finding the tab.
//
// The 'togglemicrophone', 'togglecamera' and 'hangup' actions are the
// call-specific ones from the Media Session spec. Support varies by browser,
// so each handler is registered defensively: an unsupported action throws on
// setActionHandler and must not take the others down with it.

export interface MediaSessionCallbacks {
  onToggleMicrophone: () => void;
  onToggleCamera: () => void;
  onHangUp: () => void;
}

export interface MediaSessionCallState {
  roomTitle: string;
  participantCount: number;
  isMicrophoneActive: boolean;
  isCameraActive: boolean;
}

type ActionName = 'togglemicrophone' | 'togglecamera' | 'hangup';

function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

function setHandler(action: string, handler: (() => void) | null): void {
  try {
    // Cast: these call-specific actions are not in every lib.dom version yet
    (navigator.mediaSession as any).setActionHandler(action, handler);
  } catch {
    // Action unsupported in this browser — the rest still apply
  }
}

/**
 * Registers the call with the OS media controls and wires the action buttons.
 * Returns a cleanup function that clears the handlers and metadata.
 */
export function startCallMediaSession(cb: MediaSessionCallbacks): () => void {
  if (!isSupported()) return () => {};

  const actions: [ActionName, () => void][] = [
    ['togglemicrophone', cb.onToggleMicrophone],
    ['togglecamera', cb.onToggleCamera],
    ['hangup', cb.onHangUp]
  ];
  actions.forEach(([name, fn]) => setHandler(name, fn));

  // Marks the page as actively playing so the OS keeps the controls on screen
  try {
    navigator.mediaSession.playbackState = 'playing';
  } catch {
    // read-only in some engines — non-fatal
  }

  return () => {
    actions.forEach(([name]) => setHandler(name, null));
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch {
      // non-fatal
    }
  };
}

/**
 * Updates what the OS shows: title/subtitle, plus the mic and camera toggle
 * states so the lock-screen buttons render in the correct on/off position.
 */
export function updateCallMediaSession(state: MediaSessionCallState): void {
  if (!isSupported()) return;

  try {
    const MetadataCtor = (window as any).MediaMetadata;
    if (MetadataCtor) {
      navigator.mediaSession.metadata = new MetadataCtor({
        title: state.roomTitle,
        artist: `${state.participantCount} katılımcı`,
        album: 'WindWatch'
      });
    }
  } catch {
    // Metadata is cosmetic — never let it break the call
  }

  // setMicrophoneActive/setCameraActive are what flip the button states; they
  // are Chromium-only at the time of writing.
  try {
    (navigator.mediaSession as any).setMicrophoneActive?.(state.isMicrophoneActive);
    (navigator.mediaSession as any).setCameraActive?.(state.isCameraActive);
  } catch {
    // unsupported — buttons still work, they just don't show active state
  }
}
