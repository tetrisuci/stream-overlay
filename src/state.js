// State shared by every page: what the control panel edits, server.py saves, and the scenes display.
//
//   title, players, results, firstTo   the bracket (see bracket.js)
//   current                            who is playing right now: { p1: {name, pronouns}, p2: {...} }
//   pronounsByName                     pronouns remembered per player name, so swapping players never shows stale ones

// What the scenes show until the control panel (via server.py) has saved something else.
// Also what you get when you open a page straight from disk with no server.
const DEFAULT_STATE = {
  title: "Double Elimination",
  // Players in seed order (seed 1 first). Any number from 2 up; byes are added automatically.
  players: ["BULLETSHIMEJI", "DAITAKU-HELIOS", "PLAYER 3", "PLAYER 4", "PLAYER 5", "PLAYER 6", "PLAYER 7", "PLAYER 8"],
  // Scores as matches finish: { "W1-1": [scoreForSlotA, scoreForSlotB], ... }
  results: {
    "W1-1": [2, 0],
    "W1-2": [1, 2],
    "W1-3": [2, 1],
    "W1-4": [2, 0],
    "L1-1": [0, 2],
  },
  firstTo: 2, // score that wins a match (2 = best of 3); null = the higher score wins
  current: {
    p1: { name: "BULLETSHIMEJI", pronouns: "he/him" },
    p2: { name: "DAITAKU-HELIOS", pronouns: "" },
  },
  pronounsByName: { BULLETSHIMEJI: "he/him" },
};

// Fills in anything missing so the rest of the code can rely on every field being there.
function normalizeState(raw) {
  raw = raw || {};
  const state = { ...DEFAULT_STATE, ...raw };
  state.players = (Array.isArray(state.players) ? state.players : []).map((n) => String(n).trim()).filter(Boolean);
  state.results = state.results && typeof state.results === "object" ? state.results : {};
  state.firstTo = Number.isInteger(state.firstTo) && state.firstTo > 0 ? state.firstTo : null;
  state.title = String(state.title ?? "");
  const current = raw.current && typeof raw.current === "object" ? raw.current : DEFAULT_STATE.current;
  const side = (key) => ({
    name: String(current[key]?.name ?? "").trim(),
    pronouns: String(current[key]?.pronouns ?? "").trim(),
  });
  state.current = { p1: side("p1"), p2: side("p2") };
  state.pronounsByName = raw.pronounsByName && typeof raw.pronounsByName === "object" ? raw.pronounsByName : {};
  return state;
}

// The state saved by the control panel through server.py, or null if there's no server / nothing saved yet.
async function fetchSavedState() {
  try {
    const response = await fetch("api/state", { cache: "no-store" });
    if (response.status !== 200) return null; // 204: the server is up but nothing has been saved yet
    return normalizeState(await response.json());
  } catch {
    return null;
  }
}

// The control password, remembered in this browser (only the control panel ever sets it).
function controlPassword() {
  try { return localStorage.getItem("controlPassword") || ""; } catch { return ""; }
}
function setControlPassword(value) {
  try {
    if (value) localStorage.setItem("controlPassword", value);
    else localStorage.removeItem("controlPassword");
  } catch { /* storage blocked: the panel will just ask again next time */ }
}

// Headers for requests that change things: JSON, plus the password if one is stored.
function writeHeaders(password = controlPassword()) {
  const headers = { "Content-Type": "application/json" };
  if (password) headers.Authorization = `Bearer ${password}`;
  return headers;
}

// Checks a password with the server without saving anything. Resolves to true if it's accepted.
async function checkPassword(password) {
  try {
    const response = await fetch("api/session", { method: "POST", headers: writeHeaders(password), body: "{}" });
    return response.ok;
  } catch {
    return false;
  }
}

// Saves state through server.py. Resolves to the HTTP status (200 = saved, 401 = wrong password), or 0 if the server can't be reached.
async function saveState(state) {
  try {
    const response = await fetch("api/state", { method: "POST", headers: writeHeaders(), body: JSON.stringify(state) });
    return response.status;
  } catch {
    return 0;
  }
}
