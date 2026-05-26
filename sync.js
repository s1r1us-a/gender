/* Sync-Layer: Pending-Queue, lokale Persistenz, Firebase-Listener.
   Bestimmt alleine, wann state.data und state.pendingQueue mutiert werden,
   und benachrichtigt danach Subscriber via state.notify(). */

import {
  ref, onValue, push, update, remove, get, set, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { db } from "./firebase.js";
import { state, canWrite, notify } from "./state.js";
import { dayKey } from "./stats.js";
import { notifySyncIssue } from "./ui.js";

const LS_DATA = "tracker.checkins.v1";
const LS_PENDING = "tracker.pending.v1";

let flushTimer = null;
let backoffMs = 2000;

function loadLocal() {
  try { return JSON.parse(localStorage.getItem(LS_DATA) || "{}"); }
  catch { return {}; }
}
export function saveLocal() {
  try { localStorage.setItem(LS_DATA, JSON.stringify(state.data)); } catch {}
}
function loadPending() {
  try { return JSON.parse(localStorage.getItem(LS_PENDING) || "[]"); }
  catch { return []; }
}
export function savePending() {
  try { localStorage.setItem(LS_PENDING, JSON.stringify(state.pendingQueue)); } catch {}
}

/* Pending-Ops auf eine frisch geladene Daten-Snapshot anwenden. */
function applyPending(data) {
  for (const p of state.pendingQueue) {
    if (p.op === "push") {
      if (!data[p.dk]) data[p.dk] = {};
      data[p.dk][p.tempId] = p.payload;
    } else if (p.op === "update") {
      // Server-seitig schon gelöschte Einträge nicht aus Pending-Payload "wiederbeleben".
      if (!data[p.dk] || !data[p.dk][p.entryId]) continue;
      data[p.dk][p.entryId] = { ...data[p.dk][p.entryId], ...p.payload };
      // null-Felder bedeuten Löschung
      for (const k in p.payload) if (p.payload[k] === null) delete data[p.dk][p.entryId][k];
    } else if (p.op === "delete") {
      if (data[p.dk]) {
        delete data[p.dk][p.entryId];
        if (!Object.keys(data[p.dk]).length) delete data[p.dk];
      }
    }
  }
}

export function updateStatus() {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  if (!statusDot || !statusText) return;
  const n = state.pendingQueue.length;
  if (state.dbError) {
    statusDot.className = "status-dot err";
    statusText.textContent = "DB-Fehler";
    return;
  }
  if (n > 0 && !state.serverConnected) {
    statusDot.className = "status-dot err";
    statusText.textContent = `offline · ${n} lokal`;
  } else if (n > 0) {
    statusDot.className = "status-dot";
    statusText.textContent = `sync · ${n} ausstehend`;
  } else if (state.serverConnected) {
    statusDot.className = "status-dot ok";
    statusText.textContent = "verbunden";
  } else {
    statusDot.className = "status-dot err";
    statusText.textContent = "offline";
  }
}

export async function flushPending() {
  if (!canWrite()) { updateStatus(); return; }
  if (!state.serverConnected || !state.pendingQueue.length) { updateStatus(); return; }
  // Erste Op nehmen, ausführen; bei Erfolg entfernen und nächste
  const p = state.pendingQueue[0];
  try {
    if (p.op === "push") {
      const r = await push(ref(db, `checkins/${p.dk}`), p.payload);
      // Temp-ID lokal durch Server-ID ersetzen (Snapshot bestätigt es danach)
      if (state.data[p.dk] && state.data[p.dk][p.tempId]) {
        delete state.data[p.dk][p.tempId];
        state.data[p.dk][r.key] = p.payload;
        saveLocal();
      }
    } else if (p.op === "update") {
      await update(ref(db, `checkins/${p.dk}/${p.entryId}`), p.payload);
    } else if (p.op === "delete") {
      await remove(ref(db, `checkins/${p.dk}/${p.entryId}`));
    }
    state.pendingQueue.shift();
    savePending();
    backoffMs = 2000;
    updateStatus();
    notify();
    if (state.pendingQueue.length) flushPending();
  } catch (err) {
    console.warn("flush failed, will retry:", err.message);
    notifySyncIssue("Sync-Problem — wir versuchen es automatisch erneut.");
    updateStatus();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, backoffMs);
    backoffMs = Math.min(60000, backoffMs * 2);
  }
}

/* Initialisiert den Sync-Layer:
   1) lokale Daten + Pending aus localStorage laden, sofortiges Re-Paint
   2) Firebase-Connection-Status verdrahten
   3) Live-Subscription auf /checkins
*/
export function initSync() {
  state.pendingQueue = loadPending();
  state.data = loadLocal();
  applyPending(state.data);
  updateStatus();
  notify();

  onValue(ref(db, ".info/connected"), (snap) => {
    state.serverConnected = !!snap.val();
    updateStatus();
    if (state.serverConnected) flushPending();
  });

  window.addEventListener("online", () => { backoffMs = 2000; flushPending(); });

  onValue(ref(db, "checkins"), (snap) => {
    state.dbError = false;
    state.data = snap.val() || {};
    applyPending(state.data);
    saveLocal();
    notify();
    updateStatus();
  }, (err) => {
    state.dbError = true;
    updateStatus();
    notifySyncIssue("Verbindung zur Datenbank gestört. Deine Eingaben bleiben lokal gespeichert.");
    console.error(err);
  });
}

/* Reine Firebase-DB-Hilfsexporte für andere Module (z.B. auth.js,
   das `meta/users/...` schreibt). */
export { ref, get, set, serverTimestamp };

/* ---------- Datenexport ---------- */
export function exportData() {
  if (!canWrite()) return;
  const snap = {};
  for (const dk in state.data) snap[dk] = { ...state.data[dk] };
  const blob = new Blob([JSON.stringify({
    exportedAt: new Date().toISOString(),
    version: 1,
    checkins: snap
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `genderfluid-tracker-${dayKey(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
