/* Zentraler App-State + simpler Event-Bus.
   Module mutieren `state` direkt und rufen `notify()` auf, wenn andere
   Module (z.B. render) reagieren sollen. Bewusst minimal — keine Proxies,
   keine reaktiven Wrapper, damit der Code lesbar bleibt. */

const LS_RANGE = "tracker.range.v1";
const VALID_RANGES = new Set(["7d", "30d", "90d", "1y", "all"]);
function loadRange() {
  try {
    const v = localStorage.getItem(LS_RANGE);
    return VALID_RANGES.has(v) ? v : "all";
  } catch { return "all"; }
}

export const state = {
  /** dayKey → entryId → Entry */
  data: {},
  /** Aktiver Zeitraum für Statistik-Karten (#8). */
  statsRange: loadRange(),
  /** Aktuell im Kalender angezeigter Monat. */
  viewDate: new Date(),
  /** Aktuell im Sheet ausgewählter Tag oder null. */
  selectedDayKey: null,
  /** Eintrags-ID, die gerade editiert wird, oder null. */
  editingEntryId: null,
  /** Eingeloggter Firebase-User oder null. */
  currentUser: null,
  /** "admin" | "viewer" | null */
  currentRole: null,
  /** Lokale Pending-Ops (push/update/delete), die noch zum Server müssen. */
  pendingQueue: [],
  /** True, sobald Firebase-Realtime-Verbindung steht. */
  serverConnected: false,
  /** True, wenn der DB-Listener einen Error gemeldet hat. */
  dbError: false,
};

export function canWrite() {
  return state.currentRole === "admin";
}

export function setStatsRange(r) {
  if (!VALID_RANGES.has(r)) return;
  state.statsRange = r;
  try { localStorage.setItem(LS_RANGE, r); } catch {}
}

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error("listener error:", e); }
  }
}
