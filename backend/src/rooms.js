const { v4: uuidv4 } = require('uuid');

// In-memory room storage.
//
// Members are keyed by a client-generated `clientId` that survives socket
// reconnects and page reloads (it lives in the tab's sessionStorage). Keying by
// socket id instead meant every transient network drop looked like a brand-new
// user: host rights moved, mute/share state reset and a locked room refused its
// own members. The clientId is a rejoin credential, so it is never sent to
// other clients (see publicUsers).
//
// Room: { roomId, users: Map(clientId -> user), hostClientId, password,
//         isLocked, messages, emptySince }
// User: { clientId, socketId, peerId, username, isAudioMuted, isVideoMuted,
//         isScreenSharing, isReconnecting, graceTimer }
const rooms = new Map();

// An empty room (never joined, or everyone left) is kept this long so a reload
// or a quick "leave and come back" still finds it and invite links keep working.
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_ROOM_MESSAGES = 50;

function createRoom(password = null) {
  const roomId = uuidv4();
  rooms.set(roomId, {
    roomId,
    users: new Map(),
    hostClientId: null,
    password: password || null,
    isLocked: false,
    messages: [],
    emptySince: Date.now()
  });
  return roomId;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function listRooms() {
  return Array.from(rooms.values());
}

/** Members as other clients may see them — without the clientId credential. */
function publicUsers(room) {
  return Array.from(room.users.values()).map((u) => ({
    socketId: u.socketId,
    peerId: u.peerId,
    username: u.username,
    isHost: u.clientId === room.hostClientId,
    isAudioMuted: u.isAudioMuted,
    isVideoMuted: u.isVideoMuted,
    isScreenSharing: u.isScreenSharing,
    isReconnecting: u.isReconnecting
  }));
}

function hostSocketId(room) {
  const host = room.users.get(room.hostClientId);
  return host ? host.socketId : null;
}

function findUserBySocketId(room, socketId) {
  for (const user of room.users.values()) {
    if (user.socketId === socketId) return user;
  }
  return null;
}

/**
 * Adds a member, or refreshes an existing one (same clientId) in place.
 * The first member becomes host.
 */
function upsertUser(room, { clientId, socketId, peerId, username, media }) {
  const existing = room.users.get(clientId);
  const otherSharer = Array.from(room.users.values())
    .some((u) => u.clientId !== clientId && u.isScreenSharing);

  const user = existing || { clientId };
  user.socketId = socketId;
  user.peerId = peerId;
  user.username = username;
  // Clients report their real media state on (re)join so a reconnect does not
  // flip everyone's view of us back to "muted, not sharing"
  user.isAudioMuted = typeof media?.isAudioMuted === 'boolean' ? media.isAudioMuted : true;
  user.isVideoMuted = typeof media?.isVideoMuted === 'boolean' ? media.isVideoMuted : true;
  user.isScreenSharing = !!media?.isScreenSharing && !otherSharer;
  user.isReconnecting = false;
  if (user.graceTimer) {
    clearTimeout(user.graceTimer);
    user.graceTimer = null;
  }

  room.users.set(clientId, user);
  room.emptySince = null;
  if (!room.hostClientId || !room.users.has(room.hostClientId)) {
    room.hostClientId = clientId;
  }
  return user;
}

/**
 * Removes a member. The room itself is not deleted here — it is marked empty
 * and reclaimed by sweepRooms after EMPTY_ROOM_TTL_MS. If the host leaves, the
 * longest-standing remaining member is promoted.
 */
function removeUser(room, clientId) {
  const user = room.users.get(clientId);
  if (!user) return null;
  if (user.graceTimer) clearTimeout(user.graceTimer);
  room.users.delete(clientId);

  if (room.users.size === 0) {
    room.hostClientId = null;
    room.emptySince = Date.now();
    // A locked room nobody is in could never be entered again
    room.isLocked = false;
  } else if (room.hostClientId === clientId) {
    // Prefer someone who is actually connected right now
    const next = Array.from(room.users.values()).find((u) => !u.isReconnecting)
      || room.users.values().next().value;
    room.hostClientId = next.clientId;
  }
  return user;
}

/** Deletes rooms that have been empty for longer than the TTL. */
function sweepRooms() {
  let deleted = 0;
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.users.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(roomId);
      deleted++;
    }
  }
  return deleted;
}

function pushRoomMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > MAX_ROOM_MESSAGES) room.messages.shift();
}

module.exports = {
  createRoom,
  getRoom,
  listRooms,
  publicUsers,
  hostSocketId,
  findUserBySocketId,
  upsertUser,
  removeUser,
  sweepRooms,
  pushRoomMessage
};
