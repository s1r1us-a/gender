import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, onValue, push, update, remove, get, set, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, signOut, updatePassword,
  setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  dayKey, parseDayKey,
  avg, stddev, median, percentile, bucket,
  computeStats, computeCoverage, computePeriodAggregates, computeFluidityIndex,
  computeBuckets, computeWeekdayMedians
} from "./stats.js";

// HINWEIS: Damit Lesen/Schreiben funktioniert müssen die Realtime-DB-Regeln in der
// Firebase-Console entsprechend gesetzt sein. Die Daten sind persönlicher Natur –
// bitte sicherstellen, dass der Zugriff abgesichert ist.
const firebaseConfig = {
  apiKey: "AIzaSyCeX68K7Vf5QPPdcd_JKpOEi4LUYCkZmZ8",
  authDomain: "gender-4ba3f.firebaseapp.com",
  databaseURL: "https://gender-4ba3f-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "gender-4ba3f",
  storageBucket: "gender-4ba3f.firebasestorage.app",
  messagingSenderId: "1010456171607",
  appId: "1:1010456171607:web:b848b8064899d3a9f6bf12",
  measurementId: "G-MH3Q769WR3"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ---------- Auth / Rollen ---------- */
const ADMIN_EMAIL  = "raederich@outlook.com";
const VIEWER_EMAIL = "nele.busse@web.de";
const ALLOWED_EMAILS = [ADMIN_EMAIL, VIEWER_EMAIL];

let currentUser = null;
let currentRole = null; // "admin" | "viewer" | null
const canWrite = () => currentRole === "admin";

function roleFor(email) {
  const e = (email || "").trim().toLowerCase();
  if (e === ADMIN_EMAIL)  return "admin";
  if (e === VIEWER_EMAIL) return "viewer";
  return null;
}

const loginGate     = document.getElementById("loginGate");
const loginForm     = document.getElementById("loginForm");
const loginEmail    = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginError    = document.getElementById("loginError");
const loginSubmit   = document.getElementById("loginSubmit");
const changePwForm     = document.getElementById("changePwForm");
const newPassword      = document.getElementById("newPassword");
const newPasswordRepeat= document.getElementById("newPasswordRepeat");
const changePwError    = document.getElementById("changePwError");
const changePwSubmit   = document.getElementById("changePwSubmit");
const changePwCancel   = document.getElementById("changePwCancel");
const userBadge        = document.getElementById("userBadge");
const logoutBtn        = document.getElementById("logoutBtn");

function showLoginView() {
  loginGate.hidden = false;
  loginForm.hidden = false;
  changePwForm.hidden = true;
  loginError.textContent = "";
  changePwError.textContent = "";
  newPassword.value = "";
  newPasswordRepeat.value = "";
}
function showChangePwView() {
  loginGate.hidden = false;
  loginForm.hidden = true;
  changePwForm.hidden = false;
  changePwError.textContent = "";
}
function hideLoginGate() {
  loginGate.hidden = true;
  loginPassword.value = "";
  newPassword.value = "";
  newPasswordRepeat.value = "";
}

function applyRoleUI() {
  document.body.classList.toggle("viewer-mode", currentRole === "viewer");
  if (currentUser) {
    userBadge.textContent = currentUser.email || "";
    userBadge.hidden = false;
    logoutBtn.hidden = false;
  } else {
    userBadge.hidden = true;
    logoutBtn.hidden = true;
  }
}

function friendlyAuthError(err) {
  const code = err && err.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("invalid-login-credentials"))
    return "E-Mail oder Passwort stimmt nicht.";
  if (code.includes("user-not-found"))   return "Unbekannte E-Mail-Adresse.";
  if (code.includes("invalid-email"))    return "Ungültige E-Mail-Adresse.";
  if (code.includes("too-many-requests")) return "Zu viele Versuche. Bitte kurz warten.";
  if (code.includes("network"))           return "Netzwerk-Problem. Bitte erneut versuchen.";
  if (code.includes("weak-password"))     return "Passwort zu schwach (mind. 8 Zeichen).";
  if (code.includes("requires-recent-login")) return "Bitte erneut anmelden, um das Passwort zu ändern.";
  return "Anmeldung fehlgeschlagen.";
}

async function needsPasswordChange(uid) {
  try {
    const snap = await get(ref(db, `meta/users/${uid}/passwordChanged`));
    return !(snap.exists() && snap.val() === true);
  } catch {
    // Im Zweifel sicherheitshalber Wechsel verlangen.
    return true;
  }
}

loginForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  loginError.textContent = "";
  const email = (loginEmail.value || "").trim().toLowerCase();
  const pw    = loginPassword.value || "";
  if (!ALLOWED_EMAILS.includes(email)) {
    loginError.textContent = "Kein zugelassener Account.";
    return;
  }
  loginSubmit.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pw);
    // weiter geht's in onAuthStateChanged
  } catch (err) {
    loginError.textContent = friendlyAuthError(err);
  } finally {
    loginSubmit.disabled = false;
  }
});

changePwForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  changePwError.textContent = "";
  const a = newPassword.value || "";
  const b = newPasswordRepeat.value || "";
  if (a.length < 8) { changePwError.textContent = "Passwort muss mind. 8 Zeichen haben."; return; }
  if (a !== b)      { changePwError.textContent = "Passwörter stimmen nicht überein."; return; }
  if (!auth.currentUser) { changePwError.textContent = "Nicht angemeldet."; return; }
  changePwSubmit.disabled = true;
  try {
    await updatePassword(auth.currentUser, a);
    await set(ref(db, `meta/users/${auth.currentUser.uid}`), {
      passwordChanged: true,
      changedAt: serverTimestamp(),
      email: auth.currentUser.email || null
    });
    hideLoginGate();
  } catch (err) {
    changePwError.textContent = friendlyAuthError(err);
  } finally {
    changePwSubmit.disabled = false;
  }
});

changePwCancel.addEventListener("click", async () => {
  try { await signOut(auth); } catch {}
});

logoutBtn.addEventListener("click", async () => {
  try { await signOut(auth); } catch {}
  // Nach Logout: Reload statt komplexem Teardown der Listener.
  location.reload();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    currentRole = null;
    applyRoleUI();
    showLoginView();
    return;
  }
  const role = roleFor(user.email);
  if (!role) {
    // Unbekannter Account: sofort wieder rauswerfen.
    await signOut(auth).catch(() => {});
    loginError.textContent = "Kein zugelassener Account.";
    return;
  }
  currentUser = user;
  currentRole = role;
  applyRoleUI();
  if (await needsPasswordChange(user.uid)) {
    showChangePwView();
  } else {
    hideLoginGate();
  }
});

/* ---------- Helpers ---------- */
const PINK = [255, 111, 181];
const BLUE = [111, 181, 255];
const lerp = (a,b,t) => a + (b-a)*t;

/* 7-stufige semantische Skala. Werte bleiben auf 0–100-Achse, damit alle
   bestehenden Statistiken, Farben und gespeicherten Daten kompatibel sind. */
const SCALE = [
  { v: 0,   label: "sehr weiblich",   tick: "♀♀" },
  { v: 17,  label: "weiblich",        tick: "♀"  },
  { v: 33,  label: "leicht weiblich", tick: "♀·" },
  { v: 50,  label: "neutral · fluid", tick: "⚧"  },
  { v: 67,  label: "leicht männlich", tick: "·♂" },
  { v: 83,  label: "männlich",        tick: "♂"  },
  { v: 100, label: "sehr männlich",   tick: "♂♂" }
];
function scaleIndexFromValue(v) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < SCALE.length; i++) {
    const d = Math.abs(SCALE[i].v - v);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}
function valueToColor(v) {
  const t = Math.max(0, Math.min(1, v/100));
  const r = Math.round(lerp(PINK[0], BLUE[0], t));
  const g = Math.round(lerp(PINK[1], BLUE[1], t));
  const b = Math.round(lerp(PINK[2], BLUE[2], t));
  return { r, g, b, hex: "#" + [r,g,b].map(x=>x.toString(16).padStart(2,"0")).join("") };
}
/* WCAG-relative-Luminanz – verlässlicher als einfache Helligkeitsmittel,
   weil Grün viel stärker zur wahrgenommenen Helligkeit beiträgt als Blau. */
function relLuminance({ r, g, b }) {
  const toLin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}
/* Liefert dunkle/helle Textfarbe je nach Hintergrund-Luminanz. */
function contrastText(c) {
  return relLuminance(c) > 0.45 ? "#1a0f29" : "#fff";
}
function valueToSymbol(v) {
  if (v <= 25) return "♀";
  if (v <= 42) return "♀⚧";
  if (v <= 58) return "⚧";
  if (v <= 75) return "⚧♂";
  return "♂";
}
/* Hero zeigt nur EIN dominantes Symbol – sonst kollidieren die
   großen iOS-Emoji-Glyphen mit der Zahl daneben. */
function valueToHeroSymbol(v) {
  if (v <= 33) return "♀";
  if (v <= 66) return "⚧";
  return "♂";
}
function valueToLabel(v) {
  return SCALE[scaleIndexFromValue(v)].label;
}
function pad(n){return String(n).padStart(2,"0");}
function fmtTime(ts){
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function setText(id, t){ const el = document.getElementById(id); if(el) el.textContent = t; }

/* ---------- State ---------- */

/**
 * @typedef {Object} Entry
 * @property {number} value      Slider-Wert auf 0–100-Achse
 * @property {number} ts         Unix-ms beim Erfassen
 * @property {string} [ort]      Tag „Ort" (was/wer/wo)
 * @property {string} [befinden] Tag „Befinden" (wie gefühlt)
 * @property {string} [note]     Freitext
 * @property {string} [situation] Legacy: wird über `ort` gelesen, beim Edit entfernt
 */
/**
 * @typedef {Object} PendingPush
 * @property {"push"} op
 * @property {string} dk
 * @property {string} tempId
 * @property {Entry} payload
 */
/**
 * @typedef {Object} PendingUpdate
 * @property {"update"} op
 * @property {string} dk
 * @property {string} entryId
 * @property {Object} payload   Teil-Entry; `null`-Felder bedeuten Lösch-Signal
 */
/**
 * @typedef {Object} PendingDelete
 * @property {"delete"} op
 * @property {string} dk
 * @property {string} entryId
 */
/** @typedef {PendingPush | PendingUpdate | PendingDelete} PendingOp */

/** @type {Record<string, Record<string, Entry>>} dayKey → entryId → Entry */
let DATA = {};
let viewDate = new Date();// month being shown
let selectedDayKey = null;
let editingEntryId = null;

/* Statusleiste – früh deklariert, weil updateStatus() schon im Init genutzt wird */
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

/* ---------- Local-first storage layer ---------- */
const LS_DATA = "tracker.checkins.v1";
const LS_PENDING = "tracker.pending.v1";

function loadLocal() {
  try { return JSON.parse(localStorage.getItem(LS_DATA) || "{}"); }
  catch { return {}; }
}
function saveLocal(data) {
  try { localStorage.setItem(LS_DATA, JSON.stringify(data)); } catch {}
}
function loadPending() {
  try { return JSON.parse(localStorage.getItem(LS_PENDING) || "[]"); }
  catch { return []; }
}
function savePending() {
  try { localStorage.setItem(LS_PENDING, JSON.stringify(pendingQueue)); } catch {}
}

/** @type {PendingOp[]} */
let pendingQueue = loadPending();
let serverConnected = false;
let dbError = false;
let flushTimer = null;
let backoffMs = 2000;
let lastSyncErrorToastAt = 0;
const SYNC_ERROR_TOAST_COOLDOWN_MS = 30000;

function notifySyncIssue(text) {
  const now = Date.now();
  if (now - lastSyncErrorToastAt < SYNC_ERROR_TOAST_COOLDOWN_MS) return;
  lastSyncErrorToastAt = now;
  if (typeof showToast === "function") {
    showToast(text, null, null, 4000);
  }
}

function applyPending(data) {
  for (const p of pendingQueue) {
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

function updateStatus() {
  const n = pendingQueue.length;
  if (dbError) {
    statusDot.className = "status-dot err";
    statusText.textContent = "DB-Fehler";
    return;
  }
  if (n > 0 && !serverConnected) {
    statusDot.className = "status-dot err";
    statusText.textContent = `offline · ${n} lokal`;
  } else if (n > 0) {
    statusDot.className = "status-dot";
    statusText.textContent = `sync · ${n} ausstehend`;
  } else if (serverConnected) {
    statusDot.className = "status-dot ok";
    statusText.textContent = "verbunden";
  } else {
    statusDot.className = "status-dot err";
    statusText.textContent = "offline";
  }
}

async function flushPending() {
  if (!canWrite()) { updateStatus(); return; }
  if (!serverConnected || !pendingQueue.length) { updateStatus(); return; }
  // Erste Op nehmen, ausführen; bei Erfolg entfernen und nächste
  const p = pendingQueue[0];
  try {
    if (p.op === "push") {
      const r = await push(ref(db, `checkins/${p.dk}`), p.payload);
      // Temp-ID lokal durch Server-ID ersetzen (Snapshot bestätigt es danach)
      if (DATA[p.dk] && DATA[p.dk][p.tempId]) {
        delete DATA[p.dk][p.tempId];
        DATA[p.dk][r.key] = p.payload;
        saveLocal(DATA);
      }
    } else if (p.op === "update") {
      await update(ref(db, `checkins/${p.dk}/${p.entryId}`), p.payload);
    } else if (p.op === "delete") {
      await remove(ref(db, `checkins/${p.dk}/${p.entryId}`));
    }
    pendingQueue.shift();
    savePending();
    backoffMs = 2000;
    updateStatus();
    renderAll();
    if (pendingQueue.length) flushPending();
  } catch (err) {
    console.warn("flush failed, will retry:", err.message);
    notifySyncIssue("Sync-Problem — wir versuchen es automatisch erneut.");
    updateStatus();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, backoffMs);
    backoffMs = Math.min(60000, backoffMs * 2);
  }
}

/* ---------- Connection status ---------- */
onValue(ref(db, ".info/connected"), (snap) => {
  serverConnected = !!snap.val();
  updateStatus();
  if (serverConnected) flushPending();
});

window.addEventListener("online", () => { backoffMs = 2000; flushPending(); });

/* Initial render aus localStorage – sofort sichtbar, bevor Firebase antwortet */
DATA = loadLocal();
applyPending(DATA);
updateStatus();

/* ---------- Firebase listener ---------- */
onValue(ref(db, "checkins"), (snap) => {
  dbError = false;
  DATA = snap.val() || {};
  applyPending(DATA);
  saveLocal(DATA);
  renderAll();
  updateStatus();
}, (err) => {
  dbError = true;
  updateStatus();
  notifySyncIssue("Verbindung zur Datenbank gestört. Deine Eingaben bleiben lokal gespeichert.");
  console.error(err);
});

/* ---------- Month grid ---------- */
const grid = document.getElementById("grid");
const monthTitle = document.getElementById("monthTitle");
const MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];

function dayAverage(dk) {
  const entries = DATA[dk];
  if (!entries) return null;
  const vals = Object.values(entries).map(e => Number(e.value)).filter(v => !isNaN(v));
  return vals.length ? avg(vals) : null;
}
function dayCount(dk){ return DATA[dk] ? Object.keys(DATA[dk]).length : 0; }

function renderGrid() {
  grid.innerHTML = "";
  const y = viewDate.getFullYear(), m = viewDate.getMonth();
  monthTitle.textContent = `${MONTH_NAMES[m]} ${y}`;
  const first = new Date(y, m, 1);
  const last  = new Date(y, m+1, 0);
  // Monday-first offset
  let offset = (first.getDay() + 6) % 7;
  for (let i=0;i<offset;i++){
    const c = document.createElement("div");
    c.className = "cell empty";
    grid.appendChild(c);
  }
  const todayKey = dayKey(new Date());
  for (let d=1; d<=last.getDate(); d++){
    const dt = new Date(y,m,d);
    const dk = dayKey(dt);
    const cell = document.createElement("div");
    cell.className = "cell";
    const ag = dayAverage(dk);
    if (ag === null) cell.classList.add("no-data");
    else {
      const c = valueToColor(ag);
      cell.style.background = `linear-gradient(160deg, rgba(${c.r},${c.g},${c.b},0.95), rgba(${c.r},${c.g},${c.b},0.65))`;
    }
    if (dk === todayKey) cell.classList.add("today");
    if (dt > new Date()) cell.classList.add("future");
    cell.innerHTML = `<div class="day-num">${d}</div>`;
    const cnt = dayCount(dk);
    if (cnt > 0) {
      const b = document.createElement("div");
      b.className = "badge";
      b.textContent = cnt;
      cell.appendChild(b);
      const sym = document.createElement("div");
      sym.className = "sym";
      sym.textContent = valueToSymbol(ag);
      cell.appendChild(sym);
    }
    cell.addEventListener("click", () => openSheet(dk));
    grid.appendChild(cell);
  }
}

document.getElementById("prevMonth").onclick = () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth()-1, 1); renderGrid(); };
document.getElementById("nextMonth").onclick = () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth()+1, 1); renderGrid(); };
document.getElementById("todayBtn").onclick  = () => { viewDate = new Date(); renderGrid(); };

/* ---------- Sheet / Check-in ---------- */
const backdrop = document.getElementById("backdrop");
const sheet = document.getElementById("sheet");
const slider = document.getElementById("slider");
const feelSym = document.getElementById("feelSym");
const feelLabel = document.getElementById("feelLabel");
const feelVal = document.getElementById("feelVal");
const timeInput = document.getElementById("timeInput");
const sheetTitle = document.getElementById("sheetTitle");
const sheetSubtitle = document.getElementById("sheetSubtitle");
const entryList = document.getElementById("entryList");
const entriesTitle = document.getElementById("entriesTitle");
const ortSelect = document.getElementById("ortSelect");
const ortInput = document.getElementById("ortInput");
const befindenSelect = document.getElementById("befindenSelect");
const befindenInput = document.getElementById("befindenInput");
const sliderTicks = document.getElementById("sliderTicks");
const noteInput = document.getElementById("noteInput");
const noteCount = document.getElementById("noteCount");

// Render tick marks unter dem Slider (einmalig)
sliderTicks.innerHTML = SCALE.map(s => `<span>${s.tick}</span>`).join("");

function sliderValue() {
  return SCALE[Number(slider.value)].v;
}
function setSliderToValue(v) {
  slider.value = String(scaleIndexFromValue(Number(v)));
}

function updateFeel() {
  const v = sliderValue();
  const c = valueToColor(v);
  feelSym.textContent = valueToSymbol(v);
  feelLabel.textContent = valueToLabel(v);
  feelVal.textContent = v;
  feelSym.style.color = c.hex;
  feelSym.style.textShadow = `0 0 24px ${c.hex}`;
  feelSym.style.transform = `scale(${1 + Math.abs(v-50)/200})`;
  sheet.style.boxShadow = `0 30px 80px rgba(0,0,0,0.55), 0 0 0 2px rgba(${c.r},${c.g},${c.b},0.35), 0 0 60px rgba(${c.r},${c.g},${c.b},0.25)`;
}
slider.addEventListener("input", updateFeel);

/* Notiz-Counter live aktualisieren */
function updateNoteCount() {
  const len = (noteInput.value || "").length;
  noteCount.textContent = String(len);
  noteCount.parentElement.classList.toggle("near-limit", len >= 220);
}
noteInput.addEventListener("input", updateNoteCount);

/* Tag-Dropdowns (Ort + Befinden) */
function collectKnownTagValues(key) {
  const set = new Set();
  for (const dk in DATA) {
    for (const id in DATA[dk]) {
      const e = DATA[dk][id];
      // Ort liest legacy `situation` mit, damit bestehende Werte im Dropdown auftauchen.
      const raw = key === "ort" ? (e.ort ?? e.situation) : e[key];
      const s = (raw || "").trim();
      if (s) set.add(s);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
}
function populateTagSelect(selectEl, inputEl, known, emptyLabel, newLabel, selected) {
  // Optionen via DOM-API erzeugen statt innerHTML — vermeidet jegliche
  // HTML-Injection durch Tag-Namen (z.B. "</option><script>").
  selectEl.replaceChildren();
  const makeOpt = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };
  selectEl.append(makeOpt("", emptyLabel));
  for (const s of known) selectEl.append(makeOpt(s, s));
  selectEl.append(makeOpt("__new__", newLabel));
  if (selected && known.includes(selected)) {
    selectEl.value = selected;
  } else if (selected) {
    const o = makeOpt(selected, selected);
    o.selected = true;
    selectEl.append(o);
    selectEl.value = selected;
  } else {
    selectEl.value = "";
  }
  inputEl.hidden = true;
  inputEl.value = "";
}
function populateOrtOptions(selected) {
  populateTagSelect(ortSelect, ortInput, collectKnownTagValues("ort"), "— keiner —", "+ neuer Ort…", selected);
}
function populateBefindenOptions(selected) {
  populateTagSelect(befindenSelect, befindenInput, collectKnownTagValues("befinden"), "— keins —", "+ neues Befinden…", selected);
}
function wireTagSelect(selectEl, inputEl) {
  selectEl.addEventListener("change", () => {
    if (selectEl.value === "__new__") {
      inputEl.hidden = false;
      inputEl.focus();
    } else {
      inputEl.hidden = true;
      inputEl.value = "";
    }
  });
}
wireTagSelect(ortSelect, ortInput);
wireTagSelect(befindenSelect, befindenInput);

function openSheet(dk) {
  if (!canWrite()) return;
  selectedDayKey = dk;
  editingEntryId = null;
  const d = parseDayKey(dk);
  const isToday = dk === dayKey(new Date());
  sheetTitle.textContent = isToday ? "Heutiger Check-in" : `Check-in · ${d.toLocaleDateString("de-DE", {weekday:"long", day:"numeric", month:"long", year:"numeric"})}`;
  sheetSubtitle.textContent = isToday ? "Wie fühlst du dich gerade?" : "Eintrag rückwirkend erfassen oder bearbeiten.";
  // default slider value: last entry of the day, else neutral
  const entries = DATA[dk] ? Object.entries(DATA[dk]).sort((a,b)=>(a[1].ts||0)-(b[1].ts||0)) : [];
  const lastVal = entries.length ? Number(entries[entries.length-1][1].value) : NaN;
  const seed = Number.isFinite(lastVal) ? lastVal : 50;
  setSliderToValue(seed);
  updateFeel();
  // default time: now for today, 12:00 otherwise
  const now = new Date();
  if (isToday) timeInput.value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  else timeInput.value = "12:00";
  populateOrtOptions("");
  populateBefindenOptions("");
  noteInput.value = "";
  updateNoteCount();
  renderEntryList(dk);
  backdrop.classList.add("open");
  sheet.classList.add("open");
  /* Slider ist die zentrale Aktion → bekommt sofort Fokus für Tastatur-Bedienung. */
  requestAnimationFrame(() => { try { slider.focus(); } catch (_) {} });
}
function closeSheet() {
  backdrop.classList.remove("open");
  sheet.classList.remove("open");
  selectedDayKey = null;
  editingEntryId = null;
}

/* A11y: Fokus innerhalb des offenen Sheets halten (Tab-Falle). */
function focusableInSheet() {
  return Array.from(sheet.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null);
}
document.addEventListener("keydown", (ev) => {
  if (!sheet.classList.contains("open")) return;
  if (ev.key === "Escape") { ev.preventDefault(); closeSheet(); return; }
  if (ev.key !== "Tab") return;
  const items = focusableInSheet();
  if (!items.length) return;
  const first = items[0], last = items[items.length-1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
});
backdrop.onclick = closeSheet;
document.getElementById("cancelBtn").onclick = closeSheet;
document.getElementById("nowBtn").onclick = () => {
  const n = new Date();
  timeInput.value = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
};

function renderEntryList(dk) {
  const entries = DATA[dk] ? Object.entries(DATA[dk]) : [];
  entries.sort((a,b)=>(a[1].ts||0)-(b[1].ts||0));
  entriesTitle.textContent = entries.length ? `Einträge dieses Tages (${entries.length})` : "Einträge dieses Tages";
  entryList.innerHTML = "";
  if (!entries.length) {
    const e = document.createElement("div");
    e.className = "entry empty-state";
    e.textContent = "Noch keine Einträge.";
    entryList.appendChild(e);
    return;
  }
  for (const [id, e] of entries) {
    const v = Number(e.value);
    const c = valueToColor(v);
    const ort = (e.ort ?? e.situation ?? "").trim();
    const bef = (e.befinden || "").trim();
    const note = (e.note || "").trim();
    const ortSafe = ort ? escapeHtml(ort) : "";
    const befSafe = bef ? escapeHtml(bef) : "";
    const noteSafe = note ? escapeHtml(note) : "";
    const tagParts = [ortSafe, befSafe].filter(Boolean);
    const row = document.createElement("div");
    row.className = "entry" + (id === editingEntryId ? " active" : "");
    row.innerHTML = `
      <div class="dot" style="background:${c.hex}"></div>
      <div class="info">
        <div class="time">${e.ts ? fmtTime(e.ts) : "—"} · ${valueToLabel(v)}</div>
        <div class="meta">Wert ${v}${tagParts.length ? ` · ${tagParts.join(" · ")}` : ""}</div>
        ${noteSafe ? `<div class="note-indicator" title="${noteSafe}">${noteSafe}</div>` : ""}
      </div>
      <button class="del" title="Löschen">✕</button>
    `;
    row.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("del")) return;
      editingEntryId = id;
      setSliderToValue(v);
      updateFeel();
      if (Number.isFinite(e.ts)) {
        const d = new Date(e.ts);
        timeInput.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } else {
        timeInput.value = "";
      }
      populateOrtOptions(ort);
      populateBefindenOptions(bef);
      noteInput.value = note;
      updateNoteCount();
      renderEntryList(dk);
    });
    row.querySelector(".del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      requestDeleteWithUndo(dk, id);
    });
    entryList.appendChild(row);
  }
}

function genTempId() {
  if (crypto && crypto.randomUUID) return "local-" + crypto.randomUUID();
  return "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function saveEntry(dk, entryId, v, ts, ort, befinden, note) {
  if (!canWrite()) return;
  if (!DATA[dk]) DATA[dk] = {};
  const cleanNote = (note || "").trim();
  if (entryId) {
    // Bearbeiten
    const updatePayload = { value: v, ts };
    updatePayload.ort = ort || null;
    updatePayload.befinden = befinden || null;
    updatePayload.note = cleanNote || null;
    // Falls dieser Eintrag noch legacy `situation` hat, beim Update wegräumen,
    // damit Ort eindeutig bleibt.
    if (DATA[dk][entryId] && DATA[dk][entryId].situation !== undefined) {
      updatePayload.situation = null;
    }
    // Lokal sofort anwenden: leere Felder werden entfernt (Payload nutzt parallel null als Lösch-Signal)
    DATA[dk][entryId] = { ...DATA[dk][entryId], value: v, ts };
    delete DATA[dk][entryId].situation;
    if (ort) DATA[dk][entryId].ort = ort;
    else delete DATA[dk][entryId].ort;
    if (befinden) DATA[dk][entryId].befinden = befinden;
    else delete DATA[dk][entryId].befinden;
    if (cleanNote) DATA[dk][entryId].note = cleanNote;
    else delete DATA[dk][entryId].note;

    if (entryId.startsWith("local-")) {
      // Pending push-Op patchen statt neue Op zu erzeugen
      const p = pendingQueue.find(q => q.op === "push" && q.tempId === entryId);
      if (p) {
        p.payload = { value: v, ts };
        if (ort) p.payload.ort = ort;
        if (befinden) p.payload.befinden = befinden;
        if (cleanNote) p.payload.note = cleanNote;
      }
    } else {
      // Wenn für denselben Eintrag schon ein `delete` in der Queue steht,
      // ergibt ein Update keinen Sinn — der delete würde sowieso gewinnen.
      // (In der UI eigentlich unerreichbar, aber defensiv.)
      const hasPendingDelete = pendingQueue.some(
        q => q.op === "delete" && q.entryId === entryId && q.dk === dk
      );
      if (!hasPendingDelete) {
        // Aufeinanderfolgende Updates für denselben Eintrag in eine Op mergen,
        // statt N Ops zu queuen — spart Roundtrips beim Offline-Editieren.
        const prev = pendingQueue.find(
          q => q.op === "update" && q.entryId === entryId && q.dk === dk
        );
        if (prev) {
          prev.payload = { ...prev.payload, ...updatePayload };
        } else {
          pendingQueue.push({ op: "update", dk, entryId, payload: updatePayload });
        }
      }
    }
  } else {
    // Neu anlegen
    const tempId = genTempId();
    const payload = { value: v, ts };
    if (ort) payload.ort = ort;
    if (befinden) payload.befinden = befinden;
    if (cleanNote) payload.note = cleanNote;
    DATA[dk][tempId] = payload;
    pendingQueue.push({ op: "push", tempId, dk, payload });
  }
  saveLocal(DATA);
  savePending();
  updateStatus();
  renderAll();
  flushPending();
}

function deleteEntry(dk, entryId) {
  if (!canWrite()) return;
  if (DATA[dk]) {
    delete DATA[dk][entryId];
    if (!Object.keys(DATA[dk]).length) delete DATA[dk];
  }
  if (entryId.startsWith("local-")) {
    // Pending push für diese temp-ID einfach rausnehmen, kein Server-Call nötig
    pendingQueue = pendingQueue.filter(q => !(q.op === "push" && q.tempId === entryId));
  } else {
    // Eventuelle update-Ops für dieselbe ID entfernen, dann delete queuen
    pendingQueue = pendingQueue.filter(q => !(q.op === "update" && q.entryId === entryId));
    pendingQueue.push({ op: "delete", dk, entryId });
  }
  saveLocal(DATA);
  savePending();
  updateStatus();
  renderAll();
  flushPending();
}

/* ---------- Soft-Delete mit Undo ----------
   Statt sofort zu löschen, blenden wir den Eintrag lokal aus und feuern
   die echte delete-Operation erst nach Ablauf des Toast-Timers ab.
   Bis dahin kann der User die Aktion rückgängig machen — ohne Server-Roundtrip. */
const UNDO_MS = 5000;
let pendingDeleteTimer = null;
let pendingDeleteSnapshot = null;

function requestDeleteWithUndo(dk, entryId) {
  if (!canWrite()) return;
  if (!DATA[dk] || !DATA[dk][entryId]) return;
  // Falls noch ein anderes Soft-Delete läuft, dieses jetzt definitiv committen
  finalizePendingDelete();

  pendingDeleteSnapshot = { dk, entryId, entry: { ...DATA[dk][entryId] } };
  // Lokal sofort ausblenden (kein Server-Call)
  delete DATA[dk][entryId];
  if (!Object.keys(DATA[dk]).length) delete DATA[dk];
  if (editingEntryId === entryId) editingEntryId = null;
  saveLocal(DATA);
  renderAll();

  pendingDeleteTimer = showToast("Eintrag gelöscht", "Rückgängig", () => {
    // Snapshot zurück ins DATA, Render
    const s = pendingDeleteSnapshot;
    pendingDeleteSnapshot = null;
    pendingDeleteTimer = null;
    if (!s) return;
    if (!DATA[s.dk]) DATA[s.dk] = {};
    DATA[s.dk][s.entryId] = s.entry;
    saveLocal(DATA);
    renderAll();
  }, UNDO_MS, finalizePendingDelete, { important: true });
}

function finalizePendingDelete() {
  if (!pendingDeleteSnapshot) return;
  const { dk, entryId } = pendingDeleteSnapshot;
  pendingDeleteSnapshot = null;
  clearTimeout(pendingDeleteTimer); pendingDeleteTimer = null;
  // Jetzt echte Pending-Queue-Op erzeugen (analog zu deleteEntry, aber ohne erneutes Lokal-Mutieren)
  if (entryId.startsWith("local-")) {
    pendingQueue = pendingQueue.filter(q => !(q.op === "push" && q.tempId === entryId));
  } else {
    pendingQueue = pendingQueue.filter(q => !(q.op === "update" && q.entryId === entryId));
    pendingQueue.push({ op: "delete", dk, entryId });
  }
  savePending();
  updateStatus();
  flushPending();
}

/* ---------- Toasts ----------
   Wichtige Toasts (z.B. Undo) dürfen nicht von beiläufigen Sync-Toasts
   zerstört werden. Vor jedem neuen Toast wird ein evtl. schwebender
   Soft-Delete sofort committet, damit der Snapshot nicht in einem
   inkonsistenten Zustand verloren geht. Der Timer wird zurückgegeben, statt
   eine globale Variable zu beschreiben — sonst überschreibt jeder Toast
   die Timer-Referenz des Undo-Flows. */
function showToast(text, actionLabel, onAction, timeoutMs = 5000, onTimeout = null, opts = {}) {
  const container = document.getElementById("toasts");
  if (!container) { if (onTimeout) onTimeout(); return null; }
  // Falls ein anderer wichtiger Toast (Undo) aktiv ist: dessen Aktion final
  // committen, damit kein "stiller" Verlust passiert.
  if (!opts.important && pendingDeleteSnapshot) {
    finalizePendingDelete();
  }
  // alte Toasts entfernen
  while (container.firstChild) container.firstChild.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.setAttribute("aria-live", "polite");
  t.innerHTML = `<span class="toast-text"></span>${onAction ? '<button class="toast-action" type="button"></button>' : ""}`;
  t.querySelector(".toast-text").textContent = text;
  let timer;
  const dismiss = (callTimeout) => {
    clearTimeout(timer);
    t.classList.remove("show");
    setTimeout(() => t.remove(), 220);
    if (callTimeout && onTimeout) onTimeout();
  };
  if (onAction) {
    const btn = t.querySelector(".toast-action");
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => { onAction(); dismiss(false); });
  }
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  timer = setTimeout(() => dismiss(true), timeoutMs);
  return timer;
}

/* ---------- Datenexport ---------- */
function exportData() {
  if (!canWrite()) return;
  // Snapshot inkl. lokaler Pending-Änderungen
  const snap = {};
  for (const dk in DATA) snap[dk] = { ...DATA[dk] };
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
const exportBtn = document.getElementById("exportBtn");
if (exportBtn) exportBtn.addEventListener("click", exportData);

/* Falls der User die Seite verlässt während ein Soft-Delete schwebt: jetzt committen */
window.addEventListener("beforeunload", finalizePendingDelete);

document.getElementById("saveBtn").onclick = () => {
  if (!canWrite()) return;
  if (!selectedDayKey) return;
  const v = sliderValue();
  const [rawHh, rawMm] = (timeInput.value || "12:00").split(":").map(Number);
  const hh = Number.isFinite(rawHh) ? Math.max(0, Math.min(23, rawHh)) : 12;
  const mm = Number.isFinite(rawMm) ? Math.max(0, Math.min(59, rawMm)) : 0;
  const d = parseDayKey(selectedDayKey);
  d.setHours(hh, mm, 0, 0);
  const ts = d.getTime();
  const readTag = (selectEl, inputEl) =>
    selectEl.value === "__new__" ? inputEl.value.trim() : selectEl.value.trim();
  const ort = readTag(ortSelect, ortInput);
  const befinden = readTag(befindenSelect, befindenInput);
  const note = (noteInput.value || "").trim();
  saveEntry(selectedDayKey, editingEntryId, v, ts, ort, befinden, note);
  closeSheet();
};

/* ---------- Statistics ----------
   Compute-Funktionen leben in stats.js (rein, testbar). Hier nur die
   Renderer, die DOM, Farben und HTML-Template-Strings produzieren. */

function renderOverviewBars(stats) {
  const agg = computePeriodAggregates(stats);
  const container = document.getElementById("overviewBars");

  function valueBar(label, value, sub) {
    if (value == null || isNaN(value)) {
      return `
        <div class="bar-row">
          <div class="bar-head"><span class="bar-name">${label}</span><span class="bar-count">${sub}</span></div>
          <div class="spectrum-bar no-data"></div>
          <div class="bar-meta"><span>keine Daten</span><span class="lbl">—</span></div>
        </div>`;
    }
    const c = valueToColor(value);
    const pct = Math.max(0, Math.min(100, value));
    return `
      <div class="bar-row">
        <div class="bar-head"><span class="bar-name">${label}</span><span class="bar-count">${sub}</span></div>
        <div class="spectrum-bar">
          <div class="spectrum-marker" style="left:${pct}%; background:${c.hex}; border-color:${c.hex};"></div>
        </div>
        <div class="bar-meta"><span>${valueToLabel(value)}</span><span class="lbl" style="color:${c.hex}">Ø ${value.toFixed(1)}</span></div>
      </div>`;
  }

  function spectrumBar() {
    if (!agg.allDayAvgs.length) {
      return `
        <div class="bar-row">
          <div class="bar-head"><span class="bar-name">Mein Spektrum</span><span class="bar-count">—</span></div>
          <div class="spectrum-bar no-data"></div>
          <div class="bar-meta"><span>keine Daten</span><span class="lbl">—</span></div>
        </div>`;
    }
    const minV = Math.min(...agg.allDayAvgs);
    const maxV = Math.max(...agg.allDayAvgs);
    const medV = median(agg.allDayAvgs);
    const p10 = percentile(agg.allDayAvgs, 10);
    const p90 = percentile(agg.allDayAvgs, 90);
    const cMed = valueToColor(medV);
    const cMin = valueToColor(minV);
    const cMax = valueToColor(maxV);
    const rangeLeft = Math.max(0, Math.min(100, p10));
    const rangeRight = Math.max(0, Math.min(100, p90));
    const lblMin = valueToLabel(minV);
    const lblMax = valueToLabel(maxV);
    const sameLabel = lblMin === lblMax;
    const spread = sameLabel
      ? `vorwiegend „${lblMin}"`
      : `zwischen „${lblMin}" und „${lblMax}"`;
    return `
      <div class="bar-row">
        <div class="bar-head">
          <span class="bar-name">Mein Spektrum</span>
          <span class="bar-count">${agg.trackedDays} Tage</span>
        </div>
        <div class="spectrum-bar">
          <div class="spectrum-range" style="left:${rangeLeft}%; right:${100-rangeRight}%;"></div>
          <div class="spectrum-marker is-small" style="left:${Math.max(0,Math.min(100,minV))}%; background:${cMin.hex}; border-color:${cMin.hex};"></div>
          <div class="spectrum-marker is-small" style="left:${Math.max(0,Math.min(100,maxV))}%; background:${cMax.hex}; border-color:${cMax.hex};"></div>
          <div class="spectrum-marker" style="left:${Math.max(0,Math.min(100,medV))}%; background:${cMed.hex}; border-color:${cMed.hex};"></div>
        </div>
        <div class="bar-meta">
          <span>${spread}</span>
          <span class="lbl" style="color:${cMed.hex}">Median ${medV.toFixed(1)}</span>
        </div>
      </div>`;
  }

  container.innerHTML = [
    valueBar("Heute", agg.todayAvg, agg.todayAvg != null ? "1 Tag" : "—"),
    valueBar("Letzte 7 Tage", agg.week, agg.weekDays + " Tage"),
    valueBar("Letzte 30 Tage", agg.month, agg.monthDays + " Tage"),
    spectrumBar()
  ].join("");
}

function renderOverviewMeta(stats) {
  const totalCheckins = stats.allEntries.length;
  const trackedDays = stats.dayKeys.length;
  const avgPerDay = trackedDays ? (totalCheckins / trackedDays) : 0;
  function statCell(label, value, sub) {
    return `<div class="stat">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="sub">${sub||""}</div>
    </div>`;
  }
  document.getElementById("overviewMeta").innerHTML = [
    statCell("Check-ins", totalCheckins, "gesamt"),
    statCell("Ø pro Tag", avgPerDay ? avgPerDay.toFixed(2) : "—", "Einträge"),
    statCell("Erfasste Tage", trackedDays, "mit Daten")
  ].join("");
}

function renderHeroToday(stats) {
  const inner = document.getElementById("heroInner");
  const agg = computePeriodAggregates(stats);
  if (agg.todayAvg == null) {
    inner.innerHTML = `
      <div class="hero-empty">
        <div class="hero-empty-title">Wie fühlst du dich gerade?</div>
        <div class="hero-empty-sub">Heute noch kein Check-in. Trag deinen Moment ein.</div>
        <button class="btn-checkin" id="heroCheckinBtn" type="button">Jetzt Check-in</button>
      </div>`;
    const btn = document.getElementById("heroCheckinBtn");
    if (btn) btn.onclick = () => openSheet(dayKey(new Date()));
    return;
  }
  const v = agg.todayAvg;
  const c = valueToColor(v);
  const sym = valueToHeroSymbol(v);
  // Trend: Heute vs. Schnitt der vorherigen 6 Tage
  const yesterdayAvgs = [];
  for (let i = 1; i <= 6; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const v2 = stats.dayAvgs[dayKey(d)];
    if (v2 != null) yesterdayAvgs.push(v2);
  }
  let trendHtml = `<span class="hero-trend"><span class="arrow">→</span> noch kein Wochenvergleich</span>`;
  if (yesterdayAvgs.length >= 2) {
    const prev = avg(yesterdayAvgs);
    const diff = v - prev;
    if (Math.abs(diff) < 3) {
      trendHtml = `<span class="hero-trend"><span class="arrow">→</span> stabil verglichen mit den letzten Tagen</span>`;
    } else {
      const arrow = diff > 0 ? "↗" : "↘";
      const word = diff > 0 ? "männlicher" : "weiblicher";
      trendHtml = `<span class="hero-trend"><span class="arrow" style="color:${c.hex}">${arrow}</span> ${Math.abs(diff).toFixed(0)} Punkte ${word} als letzte Tage</span>`;
    }
  }
  inner.innerHTML = `
    <div class="hero-sym" style="color:${c.hex}; text-shadow: 0 0 28px ${c.hex};">${sym}</div>
    <div class="hero-main">
      <div class="hero-eyebrow">Du heute</div>
      <div class="hero-value">
        <span class="num" style="color:${c.hex}">${v.toFixed(0)}</span>
        <span class="lbl">${valueToLabel(v)}</span>
      </div>
      ${trendHtml}
    </div>
    <div class="hero-cta">
      <button class="btn-checkin" id="heroCheckinBtn" type="button">+ Check-in</button>
    </div>
  `;
  const btn = document.getElementById("heroCheckinBtn");
  if (btn) btn.onclick = () => openSheet(dayKey(new Date()));
}

function renderFluidityIndex(stats) {
  const f = computeFluidityIndex(stats);
  const container = document.getElementById("fluidityRow");
  if (f.score == null) {
    container.innerHTML = `
      <div class="fluidity-score">
        <div class="num">—</div>
        <div class="lbl">${f.label}</div>
      </div>
      <div class="fluidity-explain">
        Sobald du ein paar Tage erfasst hast, zeigt dir der <b>Fluiditäts-Index</b>, wie stark deine Identität schwankt – das Kernkonzept dieser App, in einer Zahl.
      </div>`;
    return;
  }
  // Intra-Day-Anteil: wie viel der Streuung passiert innerhalb eines Tages,
  // statt zwischen Tagen. Hilft, "Tag-zu-Tag-fluid" von "Im-Tag-fluid" zu trennen.
  const swings = Object.values(stats.daySwings);
  const avgSwing = swings.length ? avg(swings) : null;
  const sub = `σ Einträge ${f.sdEntries.toFixed(1)} · σ Tage ${f.sdDays.toFixed(1)}`;
  const intraNote = avgSwing != null
    ? `<div class="fluidity-intra">Ø Schwankung <b>innerhalb eines Tages</b>: ${avgSwing.toFixed(0)} Punkte (aus ${swings.length} Tagen mit mehreren Check-ins).</div>`
    : `<div class="fluidity-intra">Erfasse mehrmals pro Tag, um die Schwankung <b>innerhalb eines Tages</b> sichtbar zu machen.</div>`;
  if (f.lowConfidence) {
    container.innerHTML = `
      <div class="fluidity-score">
        <div class="num">${f.score}</div>
        <div class="lbl">noch zu wenig Daten</div>
        <div class="sub">${sub}</div>
        <div class="meter"><div style="width:${f.score}%"></div></div>
      </div>
      <div class="fluidity-explain">
        Der <b>Fluiditäts-Index</b> berechnet sich bereits, ist bei wenigen Check-ins aber statistisch wackelig.
        Erfasse über mindestens 3 Tage und ~7 Check-ins, dann ordnen wir den Wert ein.
        ${intraNote}
      </div>`;
    return;
  }
  container.innerHTML = `
    <div class="fluidity-score">
      <div class="num">${f.score}</div>
      <div class="lbl">${f.label}</div>
      <div class="sub">${sub}</div>
      <div class="meter"><div style="width:${f.score}%"></div></div>
    </div>
    <div class="fluidity-explain">
      Dein Identitätsspektrum schwankt mit einem Index von <b>${f.score}/100</b>.
      Der Wert basiert auf der Streuung <b>aller Check-ins</b> — Schwankungen
      innerhalb eines Tages zählen genauso wie Tag-zu-Tag-Wechsel.
      ${intraNote}
    </div>`;
}

function renderSpectrumHistogram(stats) {
  const hist = document.getElementById("spectrumHist");
  const labels = document.getElementById("spectrumHistLabels");
  const counts = new Array(SCALE.length).fill(0);
  for (const v of Object.values(stats.dayAvgs)) {
    counts[scaleIndexFromValue(v)]++;
  }
  const max = Math.max(1, ...counts);
  hist.innerHTML = counts.map((n, i) => {
    const c = valueToColor(SCALE[i].v);
    const h = (n / max) * 100;
    return `<div class="sbar" style="height:${h}%; background:${c.hex};" title="${SCALE[i].label}: ${n} Tag${n===1?"":"e"}"></div>`;
  }).join("");
  labels.innerHTML = counts.map((n, i) => `
    <div>
      <div>${SCALE[i].tick}</div>
      <div class="lbl-count">${n}</div>
    </div>
  `).join("");
}

function renderBuckets(stats) {
  const b = computeBuckets(stats);
  const bar = document.getElementById("bucketBar");
  bar.children[0].style.width = b.pctF + "%";
  bar.children[1].style.width = b.pctN + "%";
  bar.children[2].style.width = b.pctM + "%";
  setText("lbWF", `weiblich · ${Math.round(b.pctF)}% (${b.f}d)`);
  setText("lbFL", `fluid · ${Math.round(b.pctN)}% (${b.n}d)`);
  setText("lbML", `männlich · ${Math.round(b.pctM)}% (${b.m}d)`);

  // Swatches Heute/Woche/Monat/All-Time aus den Period-Aggregaten
  const agg = computePeriodAggregates(stats);
  function sw(label, v) {
    if (v == null || isNaN(v)) return `<div class="swatch" style="background:#2a1a44;color:#9b8fb5">
        <div class="swatch-label">${label}</div>
        <div class="swatch-val">keine Daten</div></div>`;
    const c = valueToColor(v);
    const txt = contrastText(c);
    return `<div class="swatch" style="background:${c.hex};color:${txt}">
      <div class="swatch-label">${label}</div>
      <div class="swatch-val">Wert ${v.toFixed(1)} · ${valueToLabel(v)}</div>
    </div>`;
  }
  document.getElementById("swatches").innerHTML = [
    sw("Heute", agg.todayAvg),
    sw("Woche", agg.week),
    sw("Monat", agg.month),
    sw("All-Time", agg.allAvg)
  ].join("");
}

function renderSparkline(stats) {
  const svg = document.getElementById("sparkline");
  const days = 30;
  const today = new Date();
  const pts = [];
  for (let i=days-1; i>=0; i--) {
    const d = new Date(today); d.setDate(d.getDate()-i);
    const v = stats.dayAvgs[dayKey(d)];
    pts.push({ i: days-1-i, v });
  }
  const w = 300, h = 80, pad = 4;
  const xStep = (w - pad*2) / (days-1);
  // gradient bg line
  let path = "";
  let last = null;
  pts.forEach((p, idx) => {
    if (p.v == null) { last = null; return; }
    const x = pad + idx*xStep;
    const y = pad + (1 - p.v/100) * (h - pad*2);
    path += (last === null ? `M ${x} ${y}` : ` L ${x} ${y}`);
    last = { x, y };
  });
  /* EMA-Glättung (Halbwertszeit ~5 Tage): zeigt den Trend ohne die
     Outlier-Sprünge der Rohwerte. Wird nur fortgeführt, solange wir
     keinen Datenpunkt-Reset hatten — Lücken brechen die Linie. */
  const alpha = 2 / (5 + 1); // span=5
  let ema = null;
  let emaPath = "";
  let emaLast = null;
  pts.forEach((p, idx) => {
    if (p.v == null) { ema = null; emaLast = null; return; }
    ema = ema == null ? p.v : alpha * p.v + (1 - alpha) * ema;
    const x = pad + idx*xStep;
    const y = pad + (1 - ema/100) * (h - pad*2);
    emaPath += (emaLast === null ? `M ${x} ${y}` : ` L ${x} ${y}`);
    emaLast = { x, y };
  });
  const dots = pts.map((p, idx) => {
    if (p.v == null) return "";
    const c = valueToColor(p.v);
    const x = pad + idx*xStep;
    const y = pad + (1 - p.v/100) * (h - pad*2);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="${c.hex}" />`;
  }).join("");
  svg.innerHTML = `
    <defs>
      <linearGradient id="sg" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stop-color="#ff6fb5"/>
        <stop offset="50%" stop-color="#c79bd0"/>
        <stop offset="100%" stop-color="#6fb5ff"/>
      </linearGradient>
    </defs>
    <line x1="0" x2="${w}" y1="${h/2}" y2="${h/2}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="2 3"/>
    <path d="${path}" fill="none" stroke="url(#sg)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>
    <path d="${emaPath}" fill="none" stroke="url(#sg)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  `;
}

function renderHeatmap(stats) {
  const hm = document.getElementById("heatmap");
  hm.innerHTML = "";
  const end = new Date(); end.setHours(0,0,0,0);
  const todayK = dayKey(end);
  /* Robuster Startpunkt: exakt 365 Tage zurück (statt setMonth(-12), das
     an Monatskanten wie 31. März in nicht-existente Daten kippt) und auf
     Mitternacht normiert (DST-Schutz). */
  const start = new Date(end); start.setDate(start.getDate() - 365);
  // align start to Monday
  const offset = (start.getDay()+6)%7;
  start.setDate(start.getDate()-offset);
  /* Kalender-Iteration statt Math.ceil(ms-Diff/86400000): DST-Tage haben
     23/25 h und brechen die ms-Schätzung. Wir zählen Tage real ab. */
  const cells = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    cells.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  // Bis zur vollen Woche auffüllen
  while (cells.length % 7 !== 0) {
    const next = new Date(cells[cells.length-1]);
    next.setDate(next.getDate() + 1);
    cells.push(next);
  }
  for (const d of cells) {
    const dk = dayKey(d);
    const v = stats.dayAvgs[dk];
    const cell = document.createElement("div");
    cell.className = "hcell";
    const isFuture = dk > todayK;
    if (v != null) {
      const c = valueToColor(v);
      cell.style.background = c.hex;
      const bWord = { f: "weiblich", n: "fluid", m: "männlich" }[bucket(v)];
      cell.title = `${dk} · ${v.toFixed(1)} · ${valueToLabel(v)} (${bWord})`;
      cell.setAttribute("aria-label", cell.title);
    } else {
      cell.title = dk;
    }
    if (isFuture) {
      cell.classList.add("future");
    } else {
      cell.addEventListener("click", () => openSheet(dk));
    }
    hm.appendChild(cell);
  }
}

function renderHistogram(stats) {
  const buckets = new Array(24).fill(0);
  for (const e of stats.allEntries) {
    if (!e.ts) continue;
    const h = new Date(e.ts).getHours();
    buckets[h]++;
  }
  const max = Math.max(1, ...buckets);
  const hist = document.getElementById("hist");
  hist.innerHTML = "";
  buckets.forEach(c => {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = (c/max*100)+"%";
    bar.title = c + " Check-ins";
    hist.appendChild(bar);
  });
}

function renderWeekdays(stats) {
  /* Median statt Ø: robuster gegen einzelne Outlier-Tage, vor allem bei
     niedrigem N. Bei N=1 fällt Median = der eine Wert; das ist OK, aber
     wir markieren es visuell als "wenig Daten" (low-confidence). */
  const days = computeWeekdayMedians(stats);
  const row = document.getElementById("weekdayRow");
  row.innerHTML = "";
  for (const day of days) {
    const c = day.median != null ? valueToColor(day.median) : null;
    const div = document.createElement("div");
    div.className = "wd" + (day.lowN ? " wd-low" : "");
    div.innerHTML = `
      <div class="n">${day.name}</div>
      <div class="v" style="${c?`color:${c.hex}`:''}">${day.median!=null?day.median.toFixed(1):"—"}</div>
      <div class="sw" style="background:${c?c.hex:'rgba(255,255,255,0.06)'}"></div>
      <div class="wd-n" title="${day.n} Tag${day.n===1?"":"e"} erfasst">n=${day.n}</div>
    `;
    row.appendChild(div);
  }
}

function renderStreaks(stats) {
  // Build continuous array of last N days (with gaps as null)
  const keys = stats.dayKeys;
  let longestF=0, longestM=0, longestFL=0;
  let curF=0, curM=0, curFL=0;
  // Walk over actual data days in order
  const ordered = keys.map(k => ({k, v: stats.dayAvgs[k], b: bucket(stats.dayAvgs[k])}));
  // streaks require consecutive calendar days
  let prev = null;
  for (const o of ordered) {
    const d = parseDayKey(o.k);
    // Math.round schützt gegen DST-Drift (Sommerzeitumstellung ±1 h)
    const consecutive = prev && Math.round((d - prev)/(1000*60*60*24)) === 1;
    if (!consecutive) { curF=curM=curFL=0; }
    if (o.b==="f") { curF++; curM=0; curFL=0; } else
    if (o.b==="m") { curM++; curF=0; curFL=0; } else
                   { curFL++; curF=0; curM=0; }
    longestF = Math.max(longestF, curF);
    longestM = Math.max(longestM, curM);
    longestFL = Math.max(longestFL, curFL);
    prev = d;
  }
  // Volatility = std-dev of day averages
  const vols = Object.values(stats.dayAvgs);
  const vol = stddev(vols);
  /* Min / Max — bevorzugt Tage mit mindestens 2 Einträgen (sonst kann
     ein einzelner Ausreißer-Eintrag den "weiblichsten/männlichsten Tag
     aller Zeiten" diktieren). Fallback auf alle Tage, falls noch keine
     Multi-Eintrag-Tage existieren. */
  let minDay=null, maxDay=null;
  const pickFrom = (predicate) => {
    let lo = null, hi = null;
    for (const dk in stats.dayAvgs) {
      if (!predicate(dk)) continue;
      const v = stats.dayAvgs[dk];
      if (lo === null || v < stats.dayAvgs[lo]) lo = dk;
      if (hi === null || v > stats.dayAvgs[hi]) hi = dk;
    }
    return { lo, hi };
  };
  let picked = pickFrom(dk => (stats.dayCounts[dk] || 0) >= 2);
  if (!picked.lo) picked = pickFrom(() => true);
  minDay = picked.lo; maxDay = picked.hi;
  // Trend: linear slope of last 30 days
  const today = new Date();
  const pts = [];
  for (let i=29;i>=0;i--) {
    const d = new Date(today); d.setDate(d.getDate()-i);
    const v = stats.dayAvgs[dayKey(d)];
    if (v != null) pts.push({x: 29-i, y: v});
  }
  let slope = 0;
  if (pts.length >= 2) {
    const n = pts.length;
    const mx = pts.reduce((s,p)=>s+p.x,0)/n;
    const my = pts.reduce((s,p)=>s+p.y,0)/n;
    let num=0, den=0;
    for (const p of pts) { num += (p.x-mx)*(p.y-my); den += (p.x-mx)*(p.x-mx); }
    slope = den ? num/den : 0;
  }
  // Most common check-in daypart
  const parts = {Morgen:0, Mittag:0, Abend:0, Nacht:0};
  for (const e of stats.allEntries) {
    if (!e.ts) continue;
    const h = new Date(e.ts).getHours();
    if (h<6) parts.Nacht++;
    else if (h<12) parts.Morgen++;
    else if (h<18) parts.Mittag++;
    else parts.Abend++;
  }
  let topPart = "—", topPartCnt=0;
  for (const k in parts) if (parts[k] > topPartCnt) { topPart=k; topPartCnt=parts[k]; }

  function cell(label, value, sub, color) {
    return `<div class="stat">
      <div class="label">${label}</div>
      <div class="value" style="${color?`color:${color}`:''}">${value}</div>
      <div class="sub">${sub||""}</div>
    </div>`;
  }
  const minColor = minDay ? valueToColor(stats.dayAvgs[minDay]).hex : null;
  const maxColor = maxDay ? valueToColor(stats.dayAvgs[maxDay]).hex : null;
  const trendArrow = slope > 0.5 ? "↗" : slope < -0.5 ? "↘" : "→";
  const trendDir = slope > 0.5 ? "Richtung männlich" : slope < -0.5 ? "Richtung weiblich" : "stabil";
  const fmtDay = dk => dk ? parseDayKey(dk).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "long" }) : "";
  const subForRecord = dk => {
    if (!dk) return "";
    const n = stats.dayCounts[dk] || 0;
    return `${fmtDay(dk)} · ${n} Check-in${n===1?"":"s"}`;
  };
  // Intra-Day-Swing-Statistik
  const swings = Object.values(stats.daySwings);
  const swingMean = swings.length ? avg(swings) : null;
  const swingMax = swings.length ? Math.max(...swings) : null;
  const cov = computeCoverage(stats);
  const coverageCell = cov
    ? cell("Tracking-Coverage",
        `${cov.coveragePct.toFixed(0)}%`,
        `${cov.trackedDays}/${cov.daysSinceFirst} Tage · längste Lücke ${cov.longestGap}d`)
    : cell("Tracking-Coverage", "—", "noch keine Daten");
  const swingCell = swingMean != null
    ? cell("Intra-Day-Swing",
        `Ø ${swingMean.toFixed(0)}`,
        `max ${swingMax.toFixed(0)} Punkte · ${swings.length} Tage`)
    : cell("Intra-Day-Swing", "—", "≥2 Check-ins/Tag nötig");
  document.getElementById("streakStats").innerHTML = [
    cell("Längste ♀-Serie", longestF + " Tage", "in Folge", "var(--pink)"),
    cell("Längste ⚧-Serie", longestFL + " Tage", "fluid in Folge", "var(--neutral)"),
    cell("Längste ♂-Serie", longestM + " Tage", "in Folge", "var(--blue)"),
    cell("Volatilität σ", vol.toFixed(1), "Streuung Tages-Mittel"),
    cell("Weiblichster Tag", minDay ? stats.dayAvgs[minDay].toFixed(1) : "—", subForRecord(minDay), minColor),
    cell("Männlichster Tag", maxDay ? stats.dayAvgs[maxDay].toFixed(1) : "—", subForRecord(maxDay), maxColor),
    cell("Trend 30d " + trendArrow, slope.toFixed(2) + "/d", trendDir),
    cell("Top-Tageszeit", topPart, topPartCnt + " Check-ins"),
    coverageCell,
    swingCell
  ].join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[ch]));
}

/* Korrelations-Matrix Ort × Befinden:
   Zeigt für jede Kombination (Ort, Befinden) den Ø-Wert (farbig) und die
   Anzahl Check-ins (Zellgröße visuell durch Opacity bei N<3 abgedämpft).
   Reduziert Zeilen/Spalten auf jene mit ausreichend Datenpunkten, damit
   die Matrix bei 50 Orten × 30 Befinden nicht explodiert. */
function renderComboMatrix(stats) {
  const container = document.getElementById("comboMatrix");
  if (!container) return;
  const combos = Object.values(stats.byCombo);
  if (combos.length === 0) {
    container.innerHTML = `<div class="sit-empty">Erfasse Ort UND Befinden im selben Check-in, um Muster zwischen beiden sichtbar zu machen.</div>`;
    return;
  }
  // Spalten = Orte mit ≥2 Check-ins gesamt, Zeilen = Befinden ≥2.
  // Sortierung: häufigste zuerst, dann alphabetisch (de).
  const orte = Object.entries(stats.byOrt)
    .filter(([, a]) => a.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], "de"))
    .map(([name]) => name);
  const befinden = Object.entries(stats.byBefinden)
    .filter(([, a]) => a.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], "de"))
    .map(([name]) => name);

  if (!orte.length || !befinden.length) {
    container.innerHTML = `<div class="sit-empty">Noch zu wenig Daten. Tagge regelmäßig sowohl Ort als auch Befinden — ab ca. 2 Vorkommen pro Tag auftauchen hier Muster.</div>`;
    return;
  }
  // Top-12 Limitierung, damit die Matrix lesbar bleibt
  const orteShown = orte.slice(0, 12);
  const befShown = befinden.slice(0, 12);
  const lookup = (o, b) => stats.byCombo[o + "␟" + b];

  let html = `<div class="combo-grid" style="grid-template-columns: minmax(80px, 1.4fr) repeat(${orteShown.length}, minmax(48px, 1fr));">`;
  // Header-Zeile
  html += `<div class="combo-corner"></div>`;
  for (const o of orteShown) {
    html += `<div class="combo-col-head" title="${escapeHtml(o)}">${escapeHtml(o)}</div>`;
  }
  // Datenzeilen
  for (const b of befShown) {
    html += `<div class="combo-row-head" title="${escapeHtml(b)}">${escapeHtml(b)}</div>`;
    for (const o of orteShown) {
      const c = lookup(o, b);
      if (!c) {
        html += `<div class="combo-cell combo-empty" title="${escapeHtml(o)} × ${escapeHtml(b)}: keine Daten"></div>`;
        continue;
      }
      const avgV = c.sum / c.count;
      const col = valueToColor(avgV);
      const opacity = c.count >= 3 ? 1 : 0.45;
      const txt = contrastText(col);
      html += `
        <div class="combo-cell"
             style="background:${col.hex}; opacity:${opacity}; color:${txt}"
             title="${escapeHtml(o)} × ${escapeHtml(b)}: Ø ${avgV.toFixed(1)} (${valueToLabel(avgV)}) · n=${c.count}">
          <span class="combo-v">${avgV.toFixed(0)}</span>
          <span class="combo-n">${c.count}</span>
        </div>`;
    }
  }
  html += `</div>`;
  const hiddenOrte = orte.length - orteShown.length;
  const hiddenBef = befinden.length - befShown.length;
  if (hiddenOrte > 0 || hiddenBef > 0) {
    html += `<div class="combo-note">Zeigt die häufigsten 12×12. Weitere Tags ausgeblendet: ${hiddenOrte} Ort${hiddenOrte===1?"":"e"}, ${hiddenBef} Befinden.</div>`;
  }
  container.innerHTML = html;
}

function renderTagStats(containerId, byTag, emptyText) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const entries = Object.entries(byTag)
    .map(([name, agg]) => ({ name, avg: agg.sum / agg.count, count: agg.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"));

  if (!entries.length) {
    container.innerHTML = `<div class="sit-empty">${emptyText}</div>`;
    return;
  }

  container.innerHTML = entries.map(({ name, avg, count }) => {
    const c = valueToColor(avg);
    const pct = Math.max(0, Math.min(100, avg));
    const lowN = count < 5;
    return `
      <div class="sit-row${lowN ? " sit-low" : ""}">
        <div class="sit-head">
          <span class="sit-name">${escapeHtml(name)}</span>
          <span class="sit-count">${count}×${lowN ? " · wenig Daten" : ""}</span>
        </div>
        <div class="sit-bar">
          <div class="sit-marker" style="left:${pct}%; background:${c.hex}; border-color:${c.hex};"></div>
        </div>
        <div class="sit-meta">
          <span>${valueToLabel(avg)}</span>
          <span class="lbl" style="color:${c.hex}">Ø ${avg.toFixed(1)}</span>
        </div>
      </div>
    `;
  }).join("");
}

/* ---------- Auto-Insights ---------- */
function computeInsights(stats) {
  const out = [];
  const dayAvgs = stats.dayAvgs;
  const dayKeysSorted = Object.keys(dayAvgs).sort();

  // Hilfsfunktion: zentrale Diff-Formulierung mit Richtung
  const dirWord = (diff) => diff > 0 ? "männlicher" : "weiblicher";

  // 1) Tag-Extremes pro Dimension (high vs low Ø, beide N >= 5)
  const tagExtreme = (byTag, phrase, weightBase) => {
    const tagEntries = Object.entries(byTag)
      .map(([name, agg]) => ({ name, avg: agg.sum / agg.count, count: agg.count }))
      .filter(e => e.count >= 5);
    if (tagEntries.length < 2) return;
    const sorted = [...tagEntries].sort((a, b) => a.avg - b.avg);
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const diff = hi.avg - lo.avg;
    if (diff < 5) return;
    out.push({
      weight: weightBase + Math.min(20, diff),
      color: valueToColor((lo.avg + hi.avg) / 2).hex,
      text: phrase(escapeHtml(hi.name), escapeHtml(lo.name), diff.toFixed(0))
    });
  };
  tagExtreme(
    stats.byOrt,
    (hi, lo, d) => `Bei <b>${hi}</b> fühlst du dich Ø <b>${d} Punkte männlicher</b> als bei <b>${lo}</b>.`,
    90
  );
  tagExtreme(
    stats.byBefinden,
    (hi, lo, d) => `Wenn du dich <b>${hi}</b> fühlst, bist du Ø <b>${d} Punkte männlicher</b> als bei <b>${lo}</b>.`,
    88
  );

  // 2) Wochenende vs. Werktag (Ø der Tage, jeweils N >= 6)
  // Montag-first wie im Rest der App: w=0 (Mo) … w=6 (So)
  const weVals = [], wdVals = [];
  for (const dk in dayAvgs) {
    const d = parseDayKey(dk);
    const w = (d.getDay() + 6) % 7;
    (w >= 5 ? weVals : wdVals).push(dayAvgs[dk]);
  }
  if (weVals.length >= 6 && wdVals.length >= 6) {
    const we = avg(weVals), wd = avg(wdVals);
    const diff = we - wd;
    if (Math.abs(diff) >= 4) {
      out.push({
        weight: 80 + Math.min(15, Math.abs(diff)),
        color: valueToColor(we).hex,
        text: `Wochenenden sind im Schnitt <b>${Math.abs(diff).toFixed(0)} Punkte ${dirWord(diff)}</b> als Werktage.`
      });
    }
  }

  // 3) Tageszeit-Tendenz (Morgen vs. Abend, jeweils N >= 5)
  const buckets = { Morgen: [], Mittag: [], Abend: [], Nacht: [] };
  for (const e of stats.allEntries) {
    if (!e.ts) continue;
    const h = new Date(e.ts).getHours();
    if (h < 6) buckets.Nacht.push(e.value);
    else if (h < 12) buckets.Morgen.push(e.value);
    else if (h < 18) buckets.Mittag.push(e.value);
    else buckets.Abend.push(e.value);
  }
  const partAvgs = Object.entries(buckets)
    .filter(([, vals]) => vals.length >= 5)
    .map(([name, vals]) => ({ name, avg: avg(vals), count: vals.length }));
  if (partAvgs.length >= 2) {
    partAvgs.sort((a, b) => a.avg - b.avg);
    const lo = partAvgs[0], hi = partAvgs[partAvgs.length - 1];
    const diff = hi.avg - lo.avg;
    if (diff >= 5) {
      out.push({
        weight: 70 + Math.min(15, diff),
        color: valueToColor((lo.avg + hi.avg) / 2).hex,
        text: `<b>${hi.name}s</b> bist du Ø <b>${diff.toFixed(0)} Punkte männlicher</b> als <b>${lo.name.toLowerCase()}s</b>.`
      });
    }
  }

  // 4) Letzte 7 Tage vs. 30-Tage-Schnitt
  const today = new Date();
  const last7 = [], last30 = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const v = dayAvgs[dayKey(d)];
    if (v == null) continue;
    last30.push(v);
    if (i < 7) last7.push(v);
  }
  if (last7.length >= 4 && last30.length >= 10) {
    const w = avg(last7), m = avg(last30);
    const diff = w - m;
    if (Math.abs(diff) >= 4) {
      out.push({
        weight: 75 + Math.min(15, Math.abs(diff)),
        color: valueToColor(w).hex,
        text: `Diese Woche bist du <b>${Math.abs(diff).toFixed(0)} Punkte ${dirWord(diff)}</b> als dein Monatsschnitt.`
      });
    }
  }

  // 5) Aktuelle laufende Bucket-Serie (Tage in Folge im selben Bucket)
  if (dayKeysSorted.length) {
    const lastK = dayKeysSorted[dayKeysSorted.length - 1];
    const lastB = bucket(dayAvgs[lastK]);
    let run = 1;
    let prev = parseDayKey(lastK);
    for (let i = dayKeysSorted.length - 2; i >= 0; i--) {
      const k = dayKeysSorted[i];
      const d = parseDayKey(k);
      if (Math.round((prev - d) / 86400000) !== 1) break;
      if (bucket(dayAvgs[k]) !== lastB) break;
      run++;
      prev = d;
    }
    if (run >= 3) {
      const sym = lastB === "f" ? "♀" : lastB === "m" ? "♂" : "⚧";
      const word = lastB === "f" ? "weiblichen" : lastB === "m" ? "männlichen" : "fluiden";
      out.push({
        weight: 60 + Math.min(20, run * 2),
        color: valueToColor(dayAvgs[lastK]).hex,
        text: `Du bist seit <b>${run} Tagen</b> in einer ${sym}-Serie (${word} Tage in Folge).`
      });
    }
  }

  // 6) Konsistenteste Werte pro Tag-Dimension (niedrigstes σ, N >= 5)
  const consistentTag = (byTag, tagKey, phrase) => {
    const withSigma = Object.entries(byTag)
      .filter(([, agg]) => agg.count >= 5)
      .map(([name, agg]) => {
        const vals = stats.allEntries.filter(e => e[tagKey] === name).map(e => e.value);
        return { name, sigma: stddev(vals), count: agg.count };
      })
      .filter(s => s.sigma > 0)
      .sort((a, b) => a.sigma - b.sigma);
    if (withSigma.length >= 2 && withSigma[0].sigma < withSigma[1].sigma * 0.75) {
      const top = withSigma[0];
      out.push({
        weight: 55,
        color: "#c79bd0",
        text: phrase(escapeHtml(top.name), top.sigma.toFixed(1))
      });
    }
  };
  consistentTag(stats.byOrt, "ort",
    (name, sd) => `<b>${name}</b> ist dein konsistentester Ort (σ ${sd}).`);
  consistentTag(stats.byBefinden, "befinden",
    (name, sd) => `Wenn du dich <b>${name}</b> fühlst, bist du am konsistentesten (σ ${sd}).`);

  // 7) Schwankungs-Woche (σ der letzten 7 Tage deutlich höher als 30-Tage-σ)
  if (last7.length >= 4 && last30.length >= 10) {
    const s7 = stddev(last7), s30 = stddev(last30);
    if (s30 > 0 && s7 > s30 * 1.5 && s7 >= 12) {
      out.push({
        weight: 50,
        color: "#ffb86b",
        text: `Letzte Woche warst du ungewöhnlich schwankend (σ ${s7.toFixed(0)} statt ${s30.toFixed(0)}).`
      });
    }
  }

  // 8) All-Time-Rekord innerhalb der letzten 14 Tage
  //    Bevorzugt Tage mit ≥2 Einträgen, fällt sonst auf alle Tage zurück
  //    (ein einzelner Outlier-Eintrag soll nicht "Tag aller Zeiten" werden).
  if (dayKeysSorted.length >= 3) {
    let minDay = null, maxDay = null;
    const pick = (predicate) => {
      let lo = null, hi = null;
      for (const dk of dayKeysSorted) {
        if (!predicate(dk)) continue;
        const v = dayAvgs[dk];
        if (lo === null || v < dayAvgs[lo]) lo = dk;
        if (hi === null || v > dayAvgs[hi]) hi = dk;
      }
      return { lo, hi };
    };
    let picked = pick(dk => (stats.dayCounts[dk] || 0) >= 2);
    if (!picked.lo) picked = pick(() => true);
    minDay = picked.lo; maxDay = picked.hi;
    const todayK = dayKey(new Date());
    // Floor + leichtes DST-Padding: bei Sommerzeit-Wechsel rutscht der Mitternachtsabstand
    // um ±1 h; +0.5 h-Offset hält Math.floor stabil bei exakten Tageskanten.
    const daysAgo = (dk) => Math.floor((parseDayKey(todayK) - parseDayKey(dk) + 1800000) / 86400000);
    for (const [dk, kind] of [[minDay, "weiblichster"], [maxDay, "männlichster"]]) {
      const ago = daysAgo(dk);
      if (ago <= 14) {
        const when = ago === 0 ? "Heute" : ago === 1 ? "Gestern" : `Vor ${ago} Tagen`;
        out.push({
          weight: 65 - ago,
          color: valueToColor(dayAvgs[dk]).hex,
          text: `${when} war dein <b>${kind} Tag aller Zeiten</b> (Ø ${dayAvgs[dk].toFixed(0)}).`
        });
      }
    }
  }

  return out.sort((a, b) => b.weight - a.weight);
}

function renderInsights(stats) {
  const container = document.getElementById("insights");
  const insights = computeInsights(stats);
  if (!insights.length) {
    container.innerHTML = `<li class="insight insight-empty">Noch zu wenig Daten für Muster. Trag ein paar Tage mit Ort und Befinden ein — dann tauchen hier Beobachtungen auf.</li>`;
    return;
  }
  const top = insights.slice(0, 6);
  container.innerHTML = top.map(ins => `
    <li class="insight">
      <span class="insight-dot" style="background:${ins.color}"></span>
      <span class="insight-text">${ins.text}</span>
    </li>
  `).join("");
}

function applyMoodBackground(stats) {
  const allAvg = avg(Object.values(stats.dayAvgs));
  const c = allAvg != null ? valueToColor(allAvg) : { r: 199, g: 155, b: 208 };
  document.body.style.setProperty("--mood-r", c.r);
  document.body.style.setProperty("--mood-g", c.g);
  document.body.style.setProperty("--mood-b", c.b);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dr = Math.round(c.r * 0.18 + 26 * 0.82);
    const dg = Math.round(c.g * 0.18 + 16 * 0.82);
    const db = Math.round(c.b * 0.18 + 36 * 0.82);
    meta.setAttribute("content", `rgb(${dr},${dg},${db})`);
  }
}

function renderAll() {
  renderGrid();
  const stats = computeStats(DATA);
  applyMoodBackground(stats);
  renderHeroToday(stats);
  renderOverviewBars(stats);
  renderOverviewMeta(stats);
  renderFluidityIndex(stats);
  renderSpectrumHistogram(stats);
  renderBuckets(stats);
  renderSparkline(stats);
  renderHeatmap(stats);
  renderHistogram(stats);
  renderWeekdays(stats);
  renderTagStats("ortStats", stats.byOrt, "Noch keine Orte erfasst — füge im Check-in einen hinzu.");
  renderTagStats("befindenStats", stats.byBefinden, "Noch kein Befinden erfasst — füge im Check-in eins hinzu.");
  renderComboMatrix(stats);
  renderInsights(stats);
  renderStreaks(stats);
  if (sheet.classList.contains("open")) {
    const keepOrt = ortSelect.value && ortSelect.value !== "__new__" ? ortSelect.value : "";
    const keepBef = befindenSelect.value && befindenSelect.value !== "__new__" ? befindenSelect.value : "";
    populateOrtOptions(keepOrt);
    populateBefindenOptions(keepBef);
  }
  if (selectedDayKey) renderEntryList(selectedDayKey);
}

/* FAB für Quick-Check-in */
document.getElementById("quickCheckin").addEventListener("click", () => {
  openSheet(dayKey(new Date()));
});

/* Info-Karten (<details class="info">): explizites Toggle statt nativem.
   Vermeidet Race-Conditions zwischen Default-Action und Click-Listener,
   und sorgt für deterministisches Schließen auf Desktop UND Touch. */
function closeAllInfoCards() {
  for (const d of document.querySelectorAll("details.info[open]")) {
    d.removeAttribute("open");
  }
}
for (const summary of document.querySelectorAll("details.info > summary")) {
  summary.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const d = summary.parentElement;
    const wasOpen = d.hasAttribute("open");
    closeAllInfoCards();
    if (!wasOpen) d.setAttribute("open", "");
  });
}
document.addEventListener("click", (ev) => {
  const opened = document.querySelectorAll("details.info[open]");
  if (!opened.length) return;
  for (const d of opened) {
    if (!d.contains(ev.target)) d.removeAttribute("open");
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeAllInfoCards();
});

// First paint before data arrives
updateFeel();
renderAll();
