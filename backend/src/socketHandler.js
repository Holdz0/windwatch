const {
  getRoom,
  listRooms,
  publicUsers,
  hostSocketId,
  findUserBySocketId,
  upsertUser,
  removeUser,
  sweepRooms,
  pushRoomMessage
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
const joinLimiter = createRateLimiter(8, 10000);

// Text messages are capped at 500 chars; file-offer metadata needs more headroom
const MAX_TEXT_LENGTH = 500;
const MAX_FILE_META_LENGTH = 1000;
const FILE_MESSAGE_PREFIX = '[FILE]';

// A member whose socket drops (network blip, mobile backgrounding, page reload)
// keeps their seat this long. Rejoining within it is silent: no leave/join
// announcements, host rights and media state are kept.
const RECONNECT_GRACE_MS = 20000;

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
  function broadcastSystemMessage(room, text) {
    const systemMsg = makeSystemMessage(text);
    pushRoomMessage(room, systemMsg);
    io.to(room.roomId).emit('receive-message', systemMsg);
  }

  // Broadcasts the current users list to everyone in the room
  function broadcastRoomUsers(room) {
    io.to(room.roomId).emit('room-users', {
      roomUsers: publicUsers(room),
      hostSocketId: hostSocketId(room)
    });
  }

  // The room member this socket currently speaks for, or null. A socket that
  // was superseded by a newer connection of the same client no longer counts.
  function currentMember(socket) {
    const { roomId, clientId } = socket.data;
    if (!roomId || !clientId) return null;
    const room = getRoom(roomId);
    if (!room) return null;
    const user = room.users.get(clientId);
    if (!user || user.socketId !== socket.id) return null;
    return { room, user };
  }

  // Removes a member for good and tells the rest of the room
  function removeMember(room, clientId, leaveText) {
    const user = removeUser(room, clientId);
    if (!user) return;

    const memberSocket = io.sockets.sockets.get(user.socketId);
    if (memberSocket && memberSocket.data.roomId === room.roomId) {
      memberSocket.leave(room.roomId);
      memberSocket.data.roomId = null;
    }

    io.to(room.roomId).emit('user-disconnected', { socketId: user.socketId, peerId: user.peerId });
    if (room.users.size > 0) {
      broadcastRoomUsers(room);
      broadcastSystemMessage(room, leaveText || `${user.username} odadan ayrıldı.`);
    } else {
      console.log(`Room ${room.roomId} is now empty.`);
    }
  }

  // Periodically reclaim rooms that stayed empty past their TTL, and drop
  // "phantom" members whose socket vanished without a disconnect event.
  setInterval(() => {
    const connected = io.sockets.sockets;
    for (const room of listRooms()) {
      for (const user of Array.from(room.users.values())) {
        if (!user.isReconnecting && !connected.has(user.socketId)) {
          removeMember(room, user.clientId);
        }
      }
    }
    const deleted = sweepRooms();
    if (deleted > 0) {
      console.log(`Room sweeper: reclaimed ${deleted} empty room(s).`);
    }
  }, 30000).unref();

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // 1. Join (or silently rejoin) a room
    socket.on('join-room', ({ roomId, peerId, clientId, username, password, media } = {}) => {
      if (joinLimiter.isLimited(socket.id)) {
        return socket.emit('warning-msg', 'Çok sık oda değiştiriyorsunuz. Lütfen biraz bekleyin.');
      }

      const cleanRoomId = sanitize(roomId, 100);
      const cleanPeerId = sanitize(peerId, 100);
      const cleanClientId = sanitize(clientId, 100);
      const cleanUsername = sanitize(username, 30);
      const cleanPassword = typeof password === 'string' ? password.slice(0, 100) : null;

      if (!cleanRoomId || !cleanUsername || !cleanClientId || !cleanPeerId) {
        return socket.emit('error-msg', 'Oda ID ve kullanıcı adı gereklidir.');
      }

      // Rooms are only created via /create-room; joining an unknown ID is an error
      const room = getRoom(cleanRoomId);
      if (!room) {
        return socket.emit('error-msg', 'Oda bulunamadı. Bağlantının süresi dolmuş veya oda kapatılmış olabilir.');
      }

      const existing = room.users.get(cleanClientId);

      // A known member coming back (reconnect/reload) already passed these checks
      if (!existing) {
        if (room.isLocked) {
          return socket.emit('error-msg', 'Bu oda kilitli. Giriş yapamazsınız.');
        }
        if (room.password && room.password !== cleanPassword) {
          return socket.emit('password-required', { roomId: cleanRoomId });
        }
      }

      // A socket may only be in one room at a time; leave any previous room first
      const previous = currentMember(socket);
      if (previous && previous.room.roomId !== cleanRoomId) {
        removeMember(previous.room, previous.user.clientId);
      }

      const previousSocketId = existing ? existing.socketId : null;
      const previousPeerId = existing ? existing.peerId : null;

      upsertUser(room, {
        clientId: cleanClientId,
        socketId: socket.id,
        peerId: cleanPeerId,
        username: cleanUsername,
        media
      });

      socket.data.roomId = cleanRoomId;
      socket.data.clientId = cleanClientId;
      socket.join(cleanRoomId);

      // The same client on another, still-open connection (e.g. a duplicated
      // browser tab) is replaced. For an ordinary reconnect the old socket is
      // already dead and this is a no-op.
      if (previousSocketId && previousSocketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(previousSocketId);
        if (oldSocket) {
          oldSocket.data.roomId = null;
          oldSocket.leave(cleanRoomId);
          oldSocket.emit('session-replaced');
          oldSocket.disconnect(true);
        }
      }

      // Members call whoever has a new peer id (fresh join, or a reload that
      // created a new PeerJS identity)
      if (previousPeerId !== cleanPeerId) {
        socket.to(cleanRoomId).emit('user-connected', {
          socketId: socket.id,
          peerId: cleanPeerId,
          username: cleanUsername
        });
      }

      broadcastRoomUsers(room);
      socket.emit('room-history', room.messages);
      socket.emit('room-locked-status', { isLocked: room.isLocked });

      if (!existing) {
        console.log(`User ${cleanUsername} (${socket.id}) joined room ${cleanRoomId}`);
        broadcastSystemMessage(room, `${cleanUsername} odaya katıldı.`);
      }
    });

    // 1.5 Deliberate leave (the Leave button) — no grace period
    socket.on('leave-room', () => {
      const member = currentMember(socket);
      if (member) removeMember(member.room, member.user.clientId);
    });

    // 2. Chat Message Event
    socket.on('send-message', ({ roomId, text } = {}) => {
      if (messageLimiter.isLimited(socket.id)) {
        return socket.emit('warning-msg', 'Çok hızlı mesaj gönderiyorsunuz. Lütfen biraz bekleyin.');
      }
      const isFileMessage = typeof text === 'string' && text.startsWith(FILE_MESSAGE_PREFIX);
      const cleanText = sanitize(text, isFileMessage ? MAX_FILE_META_LENGTH : MAX_TEXT_LENGTH);
      if (!cleanText) return;

      const member = currentMember(socket);
      // Security check: ensure the socket is actually in the room they are sending to
      if (!member || member.room.roomId !== sanitize(roomId, 100)) {
        return socket.emit('warning-msg', 'Mesaj gönderilemedi: bu odada değilsiniz.');
      }

      const newMessage = {
        senderId: socket.id,
        senderName: member.user.username,
        text: cleanText,
        timestamp: new Date().toISOString()
      };

      pushRoomMessage(member.room, newMessage);
      io.to(member.room.roomId).emit('receive-message', newMessage);
    });

    // 2.4 Media (mute) State Sync Event
    socket.on('media-state', ({ isAudioMuted, isVideoMuted } = {}) => {
      const member = currentMember(socket);
      if (!member) return;
      if (typeof isAudioMuted === 'boolean') member.user.isAudioMuted = isAudioMuted;
      if (typeof isVideoMuted === 'boolean') member.user.isVideoMuted = isVideoMuted;
      broadcastRoomUsers(member.room);
    });

    // 2.5 Screen Share Toggle Event.
    // Acknowledged, because only one member may share at a time and the client
    // has to stop its already-captured display stream when it loses the race.
    socket.on('toggle-screen-share', ({ isSharing } = {}, ack) => {
      const respond = (payload) => {
        if (typeof ack === 'function') ack(payload);
      };

      const member = currentMember(socket);
      if (!member) return respond({ ok: false, reason: 'no-room' });
      const { room, user } = member;

      if (isSharing) {
        const otherSharer = Array.from(room.users.values())
          .find((u) => u !== user && u.isScreenSharing);
        if (otherSharer) {
          socket.emit(
            'warning-msg',
            `${otherSharer.username} şu anda ekranını paylaşıyor. Paylaşımı bitmeden yeni paylaşım başlatamazsınız.`
          );
          return respond({ ok: false, reason: 'busy', sharerName: otherSharer.username });
        }
      }

      const changed = user.isScreenSharing !== !!isSharing;
      user.isScreenSharing = !!isSharing;
      respond({ ok: true });
      broadcastRoomUsers(room);

      if (changed) {
        const action = isSharing ? 'ekranını paylaşmaya başladı.' : 'ekran paylaşımını durdurdu.';
        broadcastSystemMessage(room, `${user.username} ${action}`);
      }
    });

    // 2.6 Toggle Room Lock Event (Host only)
    socket.on('toggle-lock-room', () => {
      const member = currentMember(socket);
      if (!member || member.room.hostClientId !== member.user.clientId) return;
      const { room } = member;

      room.isLocked = !room.isLocked;
      io.to(room.roomId).emit('room-locked-status', { isLocked: room.isLocked });
      broadcastSystemMessage(
        room,
        `Oda kurucusu tarafından oda ${room.isLocked ? 'yeni girişlere kilitlendi' : 'girişlere açıldı'}.`
      );
    });

    // 2.7 Kick User Event (Host only)
    socket.on('kick-user', ({ targetSocketId } = {}) => {
      const member = currentMember(socket);
      if (!member || member.room.hostClientId !== member.user.clientId) return;
      const { room } = member;

      const target = findUserBySocketId(room, targetSocketId);
      if (!target || target === member.user) return;

      const targetSocket = io.sockets.sockets.get(target.socketId);
      if (targetSocket) {
        targetSocket.emit('kicked', 'Oda kurucusu tarafından odadan çıkarıldınız.');
      }
      removeMember(room, target.clientId, `${target.username} odadan atıldı.`);
      if (targetSocket) targetSocket.disconnect(true);
    });

    // 2.8 Remote Mute Request Event (Host only)
    socket.on('mute-user-request', ({ targetSocketId, trackKind } = {}) => {
      if (trackKind !== 'audio' && trackKind !== 'video') return;

      const member = currentMember(socket);
      if (!member || member.room.hostClientId !== member.user.clientId) return;
      if (!findUserBySocketId(member.room, targetSocketId)) return;

      io.to(targetSocketId).emit('mute-user-request', { trackKind });
    });

    // 3. Socket dropped: hold the seat for a grace period instead of leaving
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
      messageLimiter.clear(socket.id);
      joinLimiter.clear(socket.id);

      const member = currentMember(socket);
      if (!member) return;
      const { room, user } = member;

      user.isReconnecting = true;
      user.graceTimer = setTimeout(() => {
        // Still the same, still-absent connection? Then they are really gone.
        if (room.users.get(user.clientId) === user && user.isReconnecting && user.socketId === socket.id) {
          removeMember(room, user.clientId);
        }
      }, RECONNECT_GRACE_MS);
      broadcastRoomUsers(room);
    });
  });
};
