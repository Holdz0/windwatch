import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import Home from './components/Home';

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

function App() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [roomPassword, setRoomPassword] = useState<string | null>(null);

  // Parse room ID from the URL on load
  useEffect(() => {
    setRoomId(parseRoomIdFromPath());

    // Popstate event to handle browser back/forward buttons
    const handlePopState = () => {
      setRoomId(parseRoomIdFromPath());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Memoized so a re-render of App doesn't hand Room a new callback identity
  const handleJoinRoom = useCallback((selectedRoomId: string, enteredUsername: string, enteredPassword?: string) => {
    setUsername(enteredUsername);
    setRoomId(selectedRoomId);
    if (enteredPassword) {
      setRoomPassword(enteredPassword);
    }

    // Update the browser URL without reloading the page
    window.history.pushState({}, '', `/room/${encodeURIComponent(selectedRoomId)}`);
  }, []);

  const handleLeaveRoom = useCallback(() => {
    setRoomId(null);
    setUsername(null);
    setRoomPassword(null);

    // Reset URL to root
    window.history.pushState({}, '', '/');
  }, []);

  return (
    <div className="app-container">
      {!roomId || !username ? (
        <Home
          onJoinRoom={handleJoinRoom}
          initialRoomId={roomId}
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
