const {
  addUserToRoom,
  removeUserFromRoom,
  findRoomBySocketId
} = require('./rooms');

// Helper to cap text lengths (HTML escaping is handled safely on the frontend by React)
function sanitize(input, maxLength) {
  if (typeof input !== 'string') return '';
  let str = input.trim();
  if (str.length > maxLength) {
    str = str.substring(0, maxLength);
  }
  // Remove control/non-printable characters for general safety
  return str.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

// Simple in-memory rate limiting map for socket messages
const messageLimits = new Map(); // socketId -> { count, resetTime }
const MAX_MESSAGES_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_MS = 2000; // Max 10 messages per 2 seconds

function isRateLimited(socketId) {
  const now = Date.now();
  if (!messageLimits.has(socketId)) {
    messageLimits.set(socketId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  
  const limit = messageLimits.get(socketId);
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + RATE_LIMIT_WINDOW_MS;
    return false;
  }
  
  limit.count++;
  return limit.count > MAX_MESSAGES_PER_WINDOW;
}

module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // 1. Join Room Event
    socket.on('join-room', ({ roomId, peerId, username }) => {
      const cleanRoomId = sanitize(roomId, 100);
      const cleanPeerId = sanitize(peerId, 100);
      const cleanUsername = sanitize(username, 30);

      if (!cleanRoomId || !cleanUsername) {
        return socket.emit('error-msg', 'Room ID and username are required.');
      }

      console.log(`User ${cleanUsername} (${socket.id}) joining room ${cleanRoomId} with Peer ID ${cleanPeerId}`);

      // Add to our in-memory room store
      const { user, roomUsers, hostSocketId } = addUserToRoom(cleanRoomId, socket.id, cleanPeerId, cleanUsername);

      // Join the Socket.io room channel
      socket.join(cleanRoomId);

      // Tell existing users in the room that a new user has connected
      socket.to(cleanRoomId).emit('user-connected', {
        socketId: socket.id,
        peerId: user.peerId,
        username: user.username,
        isHost: user.isHost
      });

      // Send the current list of users and host details back to the client who just joined
      socket.emit('room-users', {
        roomUsers,
        hostSocketId
      });
    });

    // 2. Chat Message Event
    socket.on('send-message', ({ roomId, text }) => {
      if (isRateLimited(socket.id)) {
        return socket.emit('error-msg', 'Çok hızlı mesaj gönderiyorsunuz. Lütfen biraz bekleyin.');
      }
      const cleanRoomId = sanitize(roomId, 100);
      const cleanText = sanitize(text, 500);

      if (!cleanRoomId || !cleanText) return;

      const userRoomId = findRoomBySocketId(socket.id);
      // Security check: ensure the socket is actually in the room they are sending to
      if (userRoomId !== cleanRoomId) {
        return socket.emit('error-msg', 'Unauthorized message room send.');
      }

      // Find the user's username
      const users = require('./rooms').getRoomUsers(cleanRoomId);
      const user = users.find(u => u.socketId === socket.id);
      const senderName = user ? user.username : 'Anonymous';

      // Broadcast the message to all users in the room (including sender)
      io.to(cleanRoomId).emit('receive-message', {
        senderId: socket.id,
        senderName,
        text: cleanText,
        timestamp: new Date().toISOString()
      });
    });

    // 2.5 Screen Share Toggle Event
    socket.on('toggle-screen-share', ({ isSharing }) => {
      const roomId = findRoomBySocketId(socket.id);
      if (roomId) {
        const result = require('./rooms').setUserScreenShare(roomId, socket.id, isSharing);
        if (result) {
          io.to(roomId).emit('room-users', {
            roomUsers: result.roomUsers,
            hostSocketId: result.hostSocketId
          });
        }
      }
    });

    // 3. User Disconnected Event
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
      messageLimits.delete(socket.id);

      const roomId = findRoomBySocketId(socket.id);
      if (roomId) {
        // Remove user from the room map
        const { roomDeleted, newHostSocketId, roomUsers } = removeUserFromRoom(roomId, socket.id);

        // Tell other users in the room that this user has disconnected
        socket.to(roomId).emit('user-disconnected', { socketId: socket.id });

        if (!roomDeleted) {
          console.log(`User left room ${roomId}. Remaining users count: ${roomUsers.length}`);
          
          // If the host changed, notify the room
          io.to(roomId).emit('room-users', {
            roomUsers,
            hostSocketId: newHostSocketId
          });
        } else {
          console.log(`Room ${roomId} is now empty and has been deleted.`);
        }
      }
    });
  });
};
