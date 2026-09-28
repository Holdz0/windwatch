import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import Home from './components/Home';
import { loadSession, saveSession, clearSession } from './utils/session';

// Room pulls in peerjs + socket.io-client, which together dominate the bundle
// and are useless until someone actually joins a room. Loading it lazily keeps
// the landing screen — the only thing needed on first paint — small, which
// matters most on mobile data.
const Room = lazy(() => import('./components/Room'));

// Extracts the room ID segment from the current URL path, if any
function parseRoomIdFromPath(): string | null {
  const pathParts = window.location.pathname.split('/');
  if (pathParts[1] === 'room' && pathParts[2]) {
    try {
      return decodeURIComponent(pathParts[2]);
    } catch {
      return pathParts[2];
    }
  }
  return null;
}

// A reload of /room/<id> in a tab that was in that room rejoins directly
function restoredUsername(): string | null {
  const session = loadSession();
  const roomId = parseRoomIdFromPath();
  return session && roomId && session.roomId === roomId ? session.username : null;
}

function App() {
  const [roomId, setRoomId] = useState<string | null>(parseRoomIdFromPath);
  const [username, setUsername] = useState<string | null>(restoredUsername);
  const [roomPassword, setRoomPassword] = useState<string | null>(null);
  // Why we were sent back to the landing page (kicked, room gone, ...)
  const [leaveReason, setLeaveReason] = useState<string | null>(null);

  // Browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      setRoomId(parseRoomIdFromPath());
      setUsername(restoredUsername());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Memoized so a re-render of App doesn't hand Room a new callback identity
  const handleJoinRoom = useCallback((selectedRoomId: string, enteredUsername: string, enteredPassword?: string) => {
    setLeaveReason(null);
    setUsername(enteredUsername);
    setRoomId(selectedRoomId);
    setRoomPassword(enteredPassword || null);
    saveSession({ roomId: selectedRoomId, username: enteredUsername });

    // Update the browser URL without reloading the page
    window.history.pushState({}, '', `/room/${encodeURIComponent(selectedRoomId)}`);
  }, []);

  const handleLeaveRoom = useCallback((reason?: string) => {
    clearSession();
    setRoomId(null);
    setUsername(null);
    setRoomPassword(null);
    setLeaveReason(reason || null);

    // Reset URL to root
    window.history.pushState({}, '', '/');
  }, []);

  return (
    <div className="app-container">
      {!roomId || !username ? (
        <Home
          onJoinRoom={handleJoinRoom}
          initialRoomId={roomId}
          notice={leaveReason}
        />
      ) : (
        <Suspense fallback={<div className="app-loading"><span className="app-loading-spinner" /></div>}>
          <Room
            roomId={roomId}
            username={username}
            initialPassword={roomPassword}
            onLeave={handleLeaveRoom}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
