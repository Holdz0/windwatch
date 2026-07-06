const {
  addUserToRoom,
  removeUserFromRoom,
  findRoomBySocketId,
  getRoomRaw,
  toggleRoomLock
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
const MAX_MESSAGES_PER_WINDOW = 15; // Increased slightly to accommodate file shares
const RATE_LIMIT_WINDOW_MS = 2000;

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
    socket.on('join-room', ({ roomId, peerId, username, password }) => {
      const cleanRoomId = sanitize(roomId, 100);
      const cleanPeerId = sanitize(peerId, 100);
      const cleanUsername = sanitize(username, 30);

      if (!cleanRoomId || !cleanUsername) {
        return socket.emit('error-msg', 'Room ID and username are required.');
      }

      // Check if room is locked or requires a password
      const room = getRoomRaw(cleanRoomId);
      if (room) {
        if (room.isLocked) {
          return socket.emit('error-msg', 'Bu oda kilitli. Giriş yapamazsınız.');
        }
        if (room.password && room.password !== password) {
          return socket.emit('password-required', { roomId: cleanRoomId });
        }
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

      // Fetch the newly updated room to retrieve messages history
      const updatedRoom = getRoomRaw(cleanRoomId);
      if (updatedRoom) {
        // Send messages history to the joined client
        socket.emit('room-history', updatedRoom.messages || []);

        // Broadcast a system message stating that the user has joined
        const systemMsg = {
          senderId: 'system',
          senderName: 'Sistem',
          text: `${cleanUsername} odaya katıldı.`,
          timestamp: new Date().toISOString()
        };
        updatedRoom.messages.push(systemMsg);
        if (updatedRoom.messages.length > 50) updatedRoom.messages.shift();
        io.to(cleanRoomId).emit('receive-message', systemMsg);
      }
    });

    // 2. Chat Message Event
    socket.on('send-message', ({ roomId, text }) => {
      if (isRateLimited(socket.id)) {
        return socket.emit('error-msg', 'Çok hızlı mesaj gönderiyorsunuz. Lütfen biraz bekleyin.');
      }
      const cleanRoomId = sanitize(roomId, 100);
      const cleanText = sanitize(text, 1000); // Allowed larger size for file metadata

      if (!cleanRoomId || !cleanText) return;

      const userRoomId = findRoomBySocketId(socket.id);
      // Security check: ensure the socket is actually in the room they are sending to
      if (userRoomId !== cleanRoomId) {
        return socket.emit('error-msg', 'Unauthorized message room send.');
      }

      // Find the user's username
      const room = getRoomRaw(cleanRoomId);
      if (!room) return;

      const user = room.users.get(socket.id);
      const senderName = user ? user.username : 'Anonymous';

      // Broadcast the message to all users in the room
      const newMessage = {
        senderId: socket.id,
        senderName,
        text: cleanText,
        timestamp: new Date().toISOString()
      };
      
      room.messages.push(newMessage);
      if (room.messages.length > 50) room.messages.shift();
      io.to(cleanRoomId).emit('receive-message', newMessage);
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

          // Broadcast system message about screen share status
          const room = getRoomRaw(roomId);
          if (room) {
            const user = room.users.get(socket.id);
            const username = user ? user.username : 'Bir kullanıcı';
            const action = isSharing ? 'ekranını paylaşmaya başladı.' : 'ekran paylaşımını durdurdu.';
            
            const systemMsg = {
              senderId: 'system',
              senderName: 'Sistem',
              text: `${username} ${action}`,
              timestamp: new Date().toISOString()
            };
            
            room.messages.push(systemMsg);
            if (room.messages.length > 50) room.messages.shift();
            io.to(roomId).emit('receive-message', systemMsg);
          }
        }
      }
    });

    // 2.6 Toggle Room Lock Event (Host only)
    socket.on('toggle-lock-room', () => {
      const roomId = findRoomBySocketId(socket.id);
      if (roomId) {
        const newLockState = toggleRoomLock(roomId, socket.id);
        if (newLockState !== null) {
          // Tell all users in the room about the new lock state
          io.to(roomId).emit('room-locked-status', { isLocked: newLockState });

          // Add system message
          const room = getRoomRaw(roomId);
          if (room) {
            const systemMsg = {
              senderId: 'system',
              senderName: 'Sistem',
              text: `Oda kurucusu tarafından oda ${newLockState ? 'yeni girişlere kilitlendi' : 'girişlere açıldı'}.`,
              timestamp: new Date().toISOString()
            };
            room.messages.push(systemMsg);
            if (room.messages.length > 50) room.messages.shift();
            io.to(roomId).emit('receive-message', systemMsg);
          }
        }
      }
    });

    // 2.7 Kick User Event (Host only)
    socket.on('kick-user', ({ targetSocketId }) => {
      const roomId = findRoomBySocketId(socket.id);
      if (roomId) {
        const room = getRoomRaw(roomId);
        if (room && room.hostSocketId === socket.id && targetSocketId !== socket.id) {
          const targetSocket = io.sockets.sockets.get(targetSocketId);
          if (targetSocket) {
            // Find target username for system message
            const targetUser = room.users.get(targetSocketId);
            const targetUsername = targetUser ? targetUser.username : 'Kullanıcı';

            // Notify target client they are kicked
            targetSocket.emit('kicked', 'Oda kurucusu tarafından odadan çıkarıldınız.');
            
            // Remove target client socket from the socket room
            targetSocket.leave(roomId);

            // Clean up room directly
            const { roomDeleted, newHostSocketId, roomUsers } = removeUserFromRoom(roomId, targetSocketId);
            
            io.to(roomId).emit('user-disconnected', { socketId: targetSocketId });

            if (!roomDeleted) {
              io.to(roomId).emit('room-users', {
                roomUsers,
                hostSocketId: newHostSocketId
              });

              // Add system message
              const systemMsg = {
                senderId: 'system',
                senderName: 'Sistem',
                text: `${targetUsername} odadan atıldı.`,
                timestamp: new Date().toISOString()
              };
              room.messages.push(systemMsg);
              if (room.messages.length > 50) room.messages.shift();
              io.to(roomId).emit('receive-message', systemMsg);
            }

            // Force disconnect the target socket connection
            targetSocket.disconnect(true);
          }
        }
      }
    });

    // 2.8 Remote Mute Request Event (Host only)
    socket.on('mute-user-request', ({ targetSocketId, trackKind }) => {
      const roomId = findRoomBySocketId(socket.id);
      if (roomId) {
        const room = getRoomRaw(roomId);
        if (room && room.hostSocketId === socket.id) {
          // Forward mute request to target user
          io.to(targetSocketId).emit('mute-user-request', { trackKind });
        }
      }
    });

    // 3. User Disconnected Event
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
      messageLimits.delete(socket.id);

      const roomId = findRoomBySocketId(socket.id);
      if (roomId) {
        // Fetch username before removing user from room
        const room = getRoomRaw(roomId);
        let leftUsername = 'Bir kullanıcı';
        if (room) {
          const user = room.users.get(socket.id);
          if (user) leftUsername = user.username;
        }

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

          // Add system message
          const updatedRoom = getRoomRaw(roomId);
          if (updatedRoom) {
            const systemMsg = {
              senderId: 'system',
              senderName: 'Sistem',
              text: `${leftUsername} odadan ayrıldı.`,
              timestamp: new Date().toISOString()
            };
            updatedRoom.messages.push(systemMsg);
            if (updatedRoom.messages.length > 50) updatedRoom.messages.shift();
            io.to(roomId).emit('receive-message', systemMsg);
          }
        } else {
          console.log(`Room ${roomId} is now empty and has been deleted.`);
        }
      }
    });
  });
};
