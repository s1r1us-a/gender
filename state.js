/* Zentraler App-State + simpler Event-Bus.
   Module mutieren `state` direkt und rufen `notify()` auf, wenn andere
   Module (z.B. render) reagieren sollen. Bewusst minimal — keine Proxies,
   keine reaktiven Wrapper, damit der Code lesbar bleibt. */

export const state = {
  /** dayKey → entryId → Entry */
  data: {},
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
