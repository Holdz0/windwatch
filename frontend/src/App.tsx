import { useState, useEffect } from 'react';
import Home from './components/Home';
import Room from './components/Room';

function App() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [roomPassword, setRoomPassword] = useState<string | null>(null);

  // Parse room ID from the URL on load
  useEffect(() => {
    const pathParts = window.location.pathname.split('/');
    // Check if the URL matches /room/some-uuid
    if (pathParts[1] === 'room' && pathParts[2]) {
      setRoomId(pathParts[2]);
    }

    // Popstate event to handle browser back/forward buttons
    const handlePopState = () => {
      const parts = window.location.pathname.split('/');
      if (parts[1] === 'room' && parts[2]) {
        setRoomId(parts[2]);
      } else {
        setRoomId(null);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleJoinRoom = (selectedRoomId: string, enteredUsername: string, enteredPassword?: string) => {
    setUsername(enteredUsername);
    setRoomId(selectedRoomId);
    if (enteredPassword) {
      setRoomPassword(enteredPassword);
    }
    
    // Update the browser URL without reloading the page
    window.history.pushState({}, '', `/room/${selectedRoomId}`);
  };

  const handleLeaveRoom = () => {
    setRoomId(null);
    setUsername(null);
    setRoomPassword(null);
    
    // Reset URL to root
    window.history.pushState({}, '', '/');
  };

  return (
    <div className="app-container">
      {!roomId || !username ? (
        <Home 
          onJoinRoom={handleJoinRoom} 
          initialRoomId={roomId} 
        />
      ) : (
        <Room 
          roomId={roomId} 
          username={username} 
          initialPassword={roomPassword}
          onLeave={handleLeaveRoom} 
        />
      )}
    </div>
  );
}

export default App;
