const {
  addUserToRoom,
  removeUserFromRoom,
  findRoomBySocketId,
  getRoomRaw,
  setUserScreenShare,
  setUserMediaState,
  pushRoomMessage,
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

// Generic sliding-window rate limiter keyed by socket ID
function createRateLimiter(maxPerWindow, windowMs) {
  const limits = new Map(); // socketId -> { count, resetTime }
  return {
    isLimited(socketId) {
      const now = Date.now();
      const limit = limits.get(socketId);
      if (!limit || now > limit.resetTime) {
        limits.set(socketId, { count: 1, resetTime: now + windowMs });
        return false;
      }
      limit.count++;
      return limit.count > maxPerWindow;
    },
    clear(socketId) {
      limits.delete(socketId);
    }
  };
}

// 15 messages / 2s accommodates fast typing plus file shares
const messageLimiter = createRateLimiter(15, 2000);
// Join attempts are cheap lookups but the success path broadcasts to the room, so cap them too
const joinLimiter = createRateLimiter(5, 10000);

// Text messages are capped at 500 chars; file-offer metadata needs more headroom
const MAX_TEXT_LENGTH = 500;
const MAX_FILE_META_LENGTH = 1000;
const FILE_MESSAGE_PREFIX = '[FILE]';

function makeSystemMessage(text) {
  return {
    senderId: 'system',
    senderName: 'Sistem',
    text,
    timestamp: new Date().toISOString()
  };
}

module.exports = (io) => {
  // Broadcasts a system message to a room and stores it in history
  function broadcastSystemMessage(roomId, text) {
    const room = getRoomRaw(roomId);
    if (!room) return;
    const systemMsg = makeSystemMessage(text);
    pushRoomMessage(room, systemMsg);
    io.to(roomId).emit('receive-message', systemMsg);
  }

  // Broadcasts the current users list to everyone in the room
  function broadcastRoomUsers(roomId) {
    const room = getRoomRaw(roomId);
    if (!room) return;
    io.to(roomId).emit('room-users', {
      roomUsers: Array.from(room.users.values()),
      hostSocketId: room.hostSocketId
    });
  }

  // Removes a socket from its room and notifies remaining members
  function leaveCurrentRoom(socket, { silent = false } = {}) {
    const roomId = findRoomBySocketId(socket.id);
    if (!roomId) return;

    const room = getRoomRaw(roomId);
    const user = room ? room.users.get(socket.id) : null;
    const leftUsername = user ? user.username : 'Bir kullanıcı';

    const { roomDeleted } = removeUserFromRoom(roomId, socket.id);
    socket.leave(roomId);

    socket.to(roomId).emit('user-disconnected', { socketId: socket.id });

    if (!roomDeleted) {
      broadcastRoomUsers(roomId);
      if (!silent) {
        broadcastSystemMessage(roomId, `${leftUsername} odadan ayrıldı.`);
      }
    } else {
      console.log(`Room ${roomId} is now empty and has been deleted.`);
    }
  }

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // 1. Join Room Event
    socket.on('join-room', ({ roomId, peerId, username, password } = {}) => {
      if (joinLimiter.isLimited(socket.id)) {
        return socket.emit('warning-msg', 'Çok sık oda değiştiriyorsunuz. Lütfen biraz bekleyin.');
      }

      const cleanRoomId = sanitize(roomId, 100);
      const cleanPeerId = sanitize(peerId, 100);
      const cleanUsername = sanitize(username, 30);
      const cleanPassword = typeof password === 'string' ? password.slice(0, 100) : null;

      if (!cleanRoomId || !cleanUsername) {
        return socket.emit('error-msg', 'Oda ID ve kullanıcı adı gereklidir.');
      }

      // Rooms are only created via /create-room; joining an unknown ID is an error
      // (previously this silently created a new room, bypassing passwords and rate limits)
      const room = getRoomRaw(cleanRoomId);
      if (!room) {
        return socket.emit('error-msg', 'Oda bulunamadı. Bağlantının süresi dolmuş veya oda kapatılmış olabilir.');
      }

      const alreadyInThisRoom = room.users.has(socket.id);

      if (!alreadyInThisRoom) {
        if (room.isLocked) {
          return socket.emit('error-msg', 'Bu oda kilitli. Giriş yapamazsınız.');
        }
        if (room.password && room.password !== cleanPassword) {
          return socket.emit('password-required', { roomId: cleanRoomId });
        }
      }

      // A socket may only be in one room at a time; leave any previous room first
      const previousRoomId = findRoomBySocketId(socket.id);
      if (previousRoomId && previousRoomId !== cleanRoomId) {
        leaveCurrentRoom(socket);
      }

      if (alreadyInThisRoom) {
        // Duplicate join (e.g. client retry): just resync state, don't re-announce
        socket.emit('room-users', {
          roomUsers: Array.from(room.users.values()),
          hostSocketId: room.hostSocketId
        });
        socket.emit('room-history', room.messages || []);
        return;
      }

      console.log(`User ${cleanUsername} (${socket.id}) joining room ${cleanRoomId} with Peer ID ${cleanPeerId}`);

      const result = addUserToRoom(cleanRoomId, socket.id, cleanPeerId, cleanUsername);
      if (!result) {
        return socket.emit('error-msg', 'Oda bulunamadı. Bağlantının süresi dolmuş veya oda kapatılmış olabilir.');
      }
      const { user, roomUsers, hostSocketId, staleSocketIds } = result;

      // Tell clients to clean up any stale entries from a previous socket of this peer
      staleSocketIds.forEach((staleId) => {
        io.to(cleanRoomId).emit('user-disconnected', { socketId: staleId });
      });

      // Join the Socket.io room channel
      socket.join(cleanRoomId);

      // Tell existing users in the room that a new user has connected
      socket.to(cleanRoomId).emit('user-connected', {
        socketId: socket.id,
        peerId: user.peerId,
        username: user.username,
        isHost: user.isHost,
        isAudioMuted: user.isAudioMuted,
        isVideoMuted: user.isVideoMuted
      });

      // Sync the full users list to everyone (also clears stale entries client-side)
      io.to(cleanRoomId).emit('room-users', { roomUsers, hostSocketId });

      // Send messages history to the joined client, then announce them
      socket.emit('room-history', room.messages || []);
      broadcastSystemMessage(cleanRoomId, `${cleanUsername} odaya katıldı.`);
    });

    // 2. Chat Message Event
    socket.on('send-message', ({ roomId, text } = {}) => {
      if (messageLimiter.isLimited(socket.id)) {
        return socket.emit('warning-msg', 'Çok hızlı mesaj gönderiyorsunuz. Lütfen biraz bekleyin.');
      }
      const cleanRoomId = sanitize(roomId, 100);
      const isFileMessage = typeof text === 'string' && text.startsWith(FILE_MESSAGE_PREFIX);
      const cleanText = sanitize(text, isFileMessage ? MAX_FILE_META_LENGTH : MAX_TEXT_LENGTH);

      if (!cleanRoomId || !cleanText) return;

      const userRoomId = findRoomBySocketId(socket.id);
      // Security check: ensure the socket is actually in the room they are sending to
      if (userRoomId !== cleanRoomId) {
        return socket.emit('warning-msg', 'Mesaj gönderilemedi: bu odada değilsiniz.');
      }

      const room = getRoomRaw(cleanRoomId);
      if (!room) return;

      const user = room.users.get(socket.id);
      const senderName = user ? user.username : 'Anonymous';

      const newMessage = {
        senderId: socket.id,
        senderName,
        text: cleanText,
        timestamp: new Date().toISOString()
      };

      pushRoomMessage(room, newMessage);
      io.to(cleanRoomId).emit('receive-message', newMessage);
    });

    // 2.4 Media (mute) State Sync Event
    socket.on('media-state', ({ isAudioMuted, isVideoMuted } = {}) => {
      const roomId = findRoomBySocketId(socket.id);
      if (!roomId) return;
      const result = setUserMediaState(roomId, socket.id, isAudioMuted, isVideoMuted);
      if (result) {
        io.to(roomId).emit('room-users', {
          roomUsers: result.roomUsers,
          hostSocketId: result.hostSocketId
        });
      }
    });

    // 2.5 Screen Share Toggle Event.
    // Acknowledged, because only one member may share at a time and the client
    // has to stop its already-captured display stream when it loses the race.
    socket.on('toggle-screen-share', ({ isSharing } = {}, ack) => {
      const respond = (payload) => {
        if (typeof ack === 'function') ack(payload);
      };

      const roomId = findRoomBySocketId(socket.id);
      if (!roomId) return respond({ ok: false, reason: 'no-room' });

      const room = getRoomRaw(roomId);
      if (!room) return respond({ ok: false, reason: 'no-room' });

      if (isSharing) {
        const otherSharer = Array.from(room.users.values())
          .find((u) => u.socketId !== socket.id && u.isScreenSharing);
        if (otherSharer) {
          socket.emit(
            'warning-msg',
            `${otherSharer.username} şu anda ekranını paylaşıyor. Paylaşımı bitmeden yeni paylaşım başlatamazsınız.`
          );
          return respond({ ok: false, reason: 'busy', sharerName: otherSharer.username });
        }
      }

      const result = setUserScreenShare(roomId, socket.id, !!isSharing);
      if (!result) return respond({ ok: false, reason: 'no-room' });

      respond({ ok: true });

      io.to(roomId).emit('room-users', {
        roomUsers: result.roomUsers,
        hostSocketId: result.hostSocketId
      });

      const user = room.users.get(socket.id);
      const username = user ? user.username : 'Bir kullanıcı';
      const action = isSharing ? 'ekranını paylaşmaya başladı.' : 'ekran paylaşımını durdurdu.';
      broadcastSystemMessage(roomId, `${username} ${action}`);
    });

    // 2.6 Toggle Room Lock Event (Host only)
    socket.on('toggle-lock-room', () => {
      const roomId = findRoomBySocketId(socket.id);
      if (!roomId) return;

      const newLockState = toggleRoomLock(roomId, socket.id);
      if (newLockState === null) return;

      io.to(roomId).emit('room-locked-status', { isLocked: newLockState });
      broadcastSystemMessage(
        roomId,
        `Oda kurucusu tarafından oda ${newLockState ? 'yeni girişlere kilitlendi' : 'girişlere açıldı'}.`
      );
    });

    // 2.7 Kick User Event (Host only)
    socket.on('kick-user', ({ targetSocketId } = {}) => {
      const roomId = findRoomBySocketId(socket.id);
      if (!roomId) return;

      const room = getRoomRaw(roomId);
      // Host-only, no self-kick, and the target must actually be in this host's room
      if (!room || room.hostSocketId !== socket.id || targetSocketId === socket.id) return;
      if (!room.users.has(targetSocketId)) return;

      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (!targetSocket) return;

      const targetUser = room.users.get(targetSocketId);
      const targetUsername = targetUser ? targetUser.username : 'Kullanıcı';

      // Notify target client they are kicked
      targetSocket.emit('kicked', 'Oda kurucusu tarafından odadan çıkarıldınız.');
      targetSocket.leave(roomId);

      const { roomDeleted } = removeUserFromRoom(roomId, targetSocketId);

      io.to(roomId).emit('user-disconnected', { socketId: targetSocketId });

      if (!roomDeleted) {
        broadcastRoomUsers(roomId);
        broadcastSystemMessage(roomId, `${targetUsername} odadan atıldı.`);
      }

      // Force disconnect the target socket connection
      targetSocket.disconnect(true);
    });

    // 2.8 Remote Mute Request Event (Host only)
    socket.on('mute-user-request', ({ targetSocketId, trackKind } = {}) => {
      if (trackKind !== 'audio' && trackKind !== 'video') return;

      const roomId = findRoomBySocketId(socket.id);
      if (!roomId) return;

      const room = getRoomRaw(roomId);
      // Host-only, and the target must be in the host's own room
      // (previously any socketId in any room could be muted)
      if (!room || room.hostSocketId !== socket.id) return;
      if (!room.users.has(targetSocketId)) return;

      io.to(targetSocketId).emit('mute-user-request', { trackKind });
    });

    // 3. User Disconnected Event
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
      messageLimiter.clear(socket.id);
      joinLimiter.clear(socket.id);
      leaveCurrentRoom(socket);
    });
  });
};
