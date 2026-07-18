const { v4: uuidv4 } = require('uuid');

// In-memory room storage
// Structure: Map(roomId -> { roomId, users: Map(socketId -> { socketId, peerId, username, isHost }), hostSocketId })
const rooms = new Map();

/**
 * Creates a new room in memory with a unique UUID.
 * @returns {string} The generated roomId.
 */
function createRoom(password = null) {
  const roomId = uuidv4();
  rooms.set(roomId, {
    roomId,
    users: new Map(),
    hostSocketId: null,
    password: password || null,
    isLocked: false,
    messages: []
  });

  // Security cleanup: If no users join the room within 2 minutes, delete it to prevent RAM leak
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && room.users.size === 0) {
      rooms.delete(roomId);
      console.log(`Garbage Collector: Room ${roomId} was created but never joined. Deleted from memory.`);
    }
  }, 120000);

  return roomId;
}

/**
 * Checks if a room exists in memory.
 * @param {string} roomId 
 * @returns {boolean}
 */
function roomExists(roomId) {
  return rooms.has(roomId);
}

/**
 * Adds a user to a room. The room must already exist (created via createRoom);
 * auto-creating rooms here previously allowed password/lock bypass and
 * unbounded room creation via join-room spam.
 * The first user joining becomes the Host. Stale entries with the same peerId
 * (e.g. after a socket reconnect) are removed and host status is carried over.
 * @param {string} roomId
 * @param {string} socketId
 * @param {string} peerId
 * @param {string} username
 * @returns {object|null} The joined user, full users list, host socket ID and
 *                        removed stale socket IDs — or null if the room does not exist.
 */
function addUserToRoom(roomId, socketId, peerId, username) {
  const room = rooms.get(roomId);
  if (!room) return null;

  // Remove stale entries left behind by a previous socket of the same peer (reconnect case)
  const staleSocketIds = [];
  let wasHostBefore = false;
  if (peerId) {
    for (const [sid, u] of room.users.entries()) {
      if (u.peerId === peerId && sid !== socketId) {
        if (room.hostSocketId === sid) wasHostBefore = true;
        room.users.delete(sid);
        staleSocketIds.push(sid);
      }
    }
  }

  const isFirstUser = room.users.size === 0;
  const isHost = isFirstUser || wasHostBefore;

  const user = {
    socketId,
    peerId,
    username,
    isHost,
    // Clients always join with fake (muted) tracks, so muted is the correct initial state
    isAudioMuted: true,
    isVideoMuted: true,
    isScreenSharing: false
  };

  room.users.set(socketId, user);

  if (isHost) {
    room.hostSocketId = socketId;
  }

  return {
    user,
    roomUsers: Array.from(room.users.values()),
    hostSocketId: room.hostSocketId,
    staleSocketIds
  };
}

/**
 * Removes a user from a room by socket ID.
 * If the room becomes empty, it is deleted from memory.
 * If the host leaves, the next available user is promoted to host.
 * @param {string} roomId 
 * @param {string} socketId 
 * @returns {object} Object indicating if room was deleted, the new host socket ID (if any), and the updated users list.
 */
function removeUserFromRoom(roomId, socketId) {
  if (!rooms.has(roomId)) {
    return { roomDeleted: true, newHostSocketId: null, roomUsers: [] };
  }

  const room = rooms.get(roomId);
  const wasHost = room.hostSocketId === socketId;

  // Remove user
  room.users.delete(socketId);

  // If the room is now empty, delete it
  if (room.users.size === 0) {
    rooms.delete(roomId);
    return { roomDeleted: true, newHostSocketId: null, roomUsers: [] };
  }

  let newHostSocketId = room.hostSocketId;

  // If the user who left was the host, assign host to the first remaining user
  if (wasHost) {
    const remainingSocketIds = Array.from(room.users.keys());
    newHostSocketId = remainingSocketIds[0];
    const newHost = room.users.get(newHostSocketId);
    if (newHost) {
      newHost.isHost = true;
      room.hostSocketId = newHostSocketId;
    }
  }

  return {
    roomDeleted: false,
    newHostSocketId,
    roomUsers: Array.from(room.users.values())
  };
}

/**
 * Retrieves all users in a specific room.
 * @param {string} roomId 
 * @returns {Array} List of room users.
 */
function getRoomUsers(roomId) {
  if (!rooms.has(roomId)) return [];
  return Array.from(rooms.get(roomId).users.values());
}

/**
 * Scans all rooms to find the room ID corresponding to a socket ID.
 * @param {string} socketId 
 * @returns {string|null} The room ID or null if not found.
 */
function findRoomBySocketId(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.users.has(socketId)) {
      return roomId;
    }
  }
  return null;
}

/**
 * Updates the screen sharing status of a user.
 * @param {string} roomId 
 * @param {string} socketId 
 * @param {boolean} isSharing 
 * @returns {object|null} Updated room users list and host socket ID, or null.
 */
function setUserScreenShare(roomId, socketId, isSharing) {
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    const user = room.users.get(socketId);
    if (user) {
      user.isScreenSharing = isSharing;
    }
    return {
      roomUsers: Array.from(room.users.values()),
      hostSocketId: room.hostSocketId
    };
  }
  return null;
}

/**
 * Updates a user's audio/video mute state so it can be synced to all clients.
 * @param {string} roomId
 * @param {string} socketId
 * @param {boolean|undefined} isAudioMuted
 * @param {boolean|undefined} isVideoMuted
 * @returns {object|null} Updated room users list and host socket ID, or null.
 */
function setUserMediaState(roomId, socketId, isAudioMuted, isVideoMuted) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const user = room.users.get(socketId);
  if (!user) return null;

  if (typeof isAudioMuted === 'boolean') user.isAudioMuted = isAudioMuted;
  if (typeof isVideoMuted === 'boolean') user.isVideoMuted = isVideoMuted;

  return {
    roomUsers: Array.from(room.users.values()),
    hostSocketId: room.hostSocketId
  };
}

const MAX_ROOM_MESSAGES = 50;

/**
 * Appends a message to the room history, enforcing the history size cap.
 * @param {object} room
 * @param {object} message
 */
function pushRoomMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > MAX_ROOM_MESSAGES) room.messages.shift();
}

/**
 * Toggles the lock status of a room.
 * @param {string} roomId 
 * @param {string} socketId 
 * @returns {boolean|null} The new lock status or null if unauthorized/not found.
 */
function toggleRoomLock(roomId, socketId) {
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    if (room.hostSocketId === socketId) {
      room.isLocked = !room.isLocked;
      return room.isLocked;
    }
  }
  return null;
}

/**
 * Retrieves the raw room object (internal use for passwords/lock checks).
 * @param {string} roomId 
 * @returns {object|undefined}
 */
function getRoomRaw(roomId) {
  return rooms.get(roomId);
}

module.exports = {
  createRoom,
  roomExists,
  addUserToRoom,
  removeUserFromRoom,
  getRoomUsers,
  findRoomBySocketId,
  setUserScreenShare,
  setUserMediaState,
  pushRoomMessage,
  toggleRoomLock,
  getRoomRaw
};
