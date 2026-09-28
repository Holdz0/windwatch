// Per-tab identity and session persistence.
//
// clientId identifies this tab to the server across socket reconnects and page
// reloads (sessionStorage survives a reload but is per tab), which is what lets
// the server treat a reconnect as "the same member is back" instead of a new
// user. The active room + name are kept alongside it so a reload drops the
// user straight back into the call instead of on the landing page.

const CLIENT_ID_KEY = 'windwatch:clientId';
const SESSION_KEY = 'windwatch:session';
const USERNAME_KEY = 'windwatch:username';

let memoryClientId: string | null = null;

function randomId(): string {
  // randomUUID only exists in secure contexts (https / localhost)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function getClientId(): string {
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = randomId();
      sessionStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    // Storage blocked — still stable for the lifetime of this page
    if (!memoryClientId) memoryClientId = randomId();
    return memoryClientId;
  }
}

export interface SavedSession {
  roomId: string;
  username: string;
}

export function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.roomId === 'string' && typeof parsed?.username === 'string') {
      return parsed;
    }
  } catch {
    // corrupted or unavailable — treat as no session
  }
  return null;
}

export function saveSession(session: SavedSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.setItem(USERNAME_KEY, session.username);
  } catch {
    // storage unavailable — reload just won't auto-rejoin
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export function loadSavedUsername(): string {
  try {
    return localStorage.getItem(USERNAME_KEY) || '';
  } catch {
    return '';
  }
}
