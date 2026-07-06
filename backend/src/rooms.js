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
 * Adds a user to a room. If the room is not pre-created, it will be initialized.
 * The first user joining becomes the Host.
 * @param {string} roomId 
 * @param {string} socketId 
 * @param {string} peerId 
 * @param {string} username 
 * @returns {object} The joined user, full list of room users, and the host's socket ID.
 */
function addUserToRoom(roomId, socketId, peerId, username) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      users: new Map(),
      hostSocketId: null,
      password: null,
      isLocked: false,
      messages: []
    });
  }

  const room = rooms.get(roomId);
  const isFirstUser = room.users.size === 0;

  const user = {
    socketId,
    peerId,
    username,
    isHost: isFirstUser
  };

  room.users.set(socketId, user);

  if (isFirstUser) {
    room.hostSocketId = socketId;
  }

  return {
    user,
    roomUsers: Array.from(room.users.values()),
    hostSocketId: room.hostSocketId
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
  toggleRoomLock,
  getRoomRaw
};
