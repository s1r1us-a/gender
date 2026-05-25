import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, onValue, push, update, remove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

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
function bucket(v) {
  if (v <= 33) return "f";
  if (v <= 66) return "n";
  return "m";
}
function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function parseDayKey(k) {
  const [y,m,d] = k.split("-").map(Number);
  return new Date(y, m-1, d);
}
function pad(n){return String(n).padStart(2,"0");}
function fmtTime(ts){
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function avg(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }
function stddev(arr){
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s,v)=>s+(v-m)*(v-m),0)/arr.length);
}
function median(arr){
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1] + s[mid]) / 2;
}
function percentile(arr, p){
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const idx = (s.length - 1) * (p/100);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function setText(id, t){ const el = document.getElementById(id); if(el) el.textContent = t; }

/* ---------- State ---------- */
let DATA = {};            // {dayKey: {pushId: {value, ts}}}
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

let pendingQueue = loadPending();   // [{ tempId?, op, dk, entryId?, payload? }]
let serverConnected = false;
let dbError = false;
let flushTimer = null;
let backoffMs = 2000;

function applyPending(data) {
  for (const p of pendingQueue) {
    if (p.op === "push") {
      if (!data[p.dk]) data[p.dk] = {};
      data[p.dk][p.tempId] = p.payload;
    } else if (p.op === "update") {
      if (!data[p.dk]) data[p.dk] = {};
      data[p.dk][p.entryId] = { ...(data[p.dk][p.entryId] || {}), ...p.payload };
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
const situationSelect = document.getElementById("situationSelect");
const situationInput = document.getElementById("situationInput");
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
  noteCount.textContent = String((noteInput.value || "").length);
}
noteInput.addEventListener("input", updateNoteCount);

/* Situation-Dropdown */
function collectKnownSituations() {
  const set = new Set();
  for (const dk in DATA) {
    for (const id in DATA[dk]) {
      const s = (DATA[dk][id].situation || "").trim();
      if (s) set.add(s);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
}
function populateSituationOptions(selected) {
  const known = collectKnownSituations();
  const opts = ['<option value="">— keine —</option>'];
  for (const s of known) {
    const safe = s.replace(/"/g, "&quot;");
    opts.push(`<option value="${safe}">${safe}</option>`);
  }
  opts.push('<option value="__new__">+ neue Situation…</option>');
  situationSelect.innerHTML = opts.join("");
  if (selected && known.includes(selected)) {
    situationSelect.value = selected;
  } else if (selected) {
    // selected exists in entry but not yet in derived list (just-deleted last usage etc.)
    const safe = selected.replace(/"/g, "&quot;");
    situationSelect.insertAdjacentHTML(
      "beforeend",
      `<option value="${safe}" selected>${safe}</option>`
    );
    situationSelect.value = selected;
  } else {
    situationSelect.value = "";
  }
  situationInput.hidden = true;
  situationInput.value = "";
}
situationSelect.addEventListener("change", () => {
  if (situationSelect.value === "__new__") {
    situationInput.hidden = false;
    situationInput.focus();
  } else {
    situationInput.hidden = true;
    situationInput.value = "";
  }
});

function openSheet(dk) {
  selectedDayKey = dk;
  editingEntryId = null;
  const d = parseDayKey(dk);
  const isToday = dk === dayKey(new Date());
  sheetTitle.textContent = isToday ? "Heutiger Check-in" : `Check-in · ${d.toLocaleDateString("de-DE", {weekday:"long", day:"numeric", month:"long", year:"numeric"})}`;
  sheetSubtitle.textContent = isToday ? "Wie fühlst du dich gerade?" : "Eintrag rückwirkend erfassen oder bearbeiten.";
  // default slider value: last entry of the day, else neutral
  const entries = DATA[dk] ? Object.entries(DATA[dk]).sort((a,b)=>(a[1].ts||0)-(b[1].ts||0)) : [];
  const seed = entries.length ? Number(entries[entries.length-1][1].value) : 50;
  setSliderToValue(seed);
  updateFeel();
  // default time: now for today, 12:00 otherwise
  const now = new Date();
  if (isToday) timeInput.value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  else timeInput.value = "12:00";
  populateSituationOptions("");
  noteInput.value = "";
  updateNoteCount();
  renderEntryList(dk);
  backdrop.classList.add("open");
  sheet.classList.add("open");
}
function closeSheet() {
  backdrop.classList.remove("open");
  sheet.classList.remove("open");
  selectedDayKey = null;
  editingEntryId = null;
}
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
    const sit = (e.situation || "").trim();
    const note = (e.note || "").trim();
    const sitSafe = sit ? escapeHtml(sit) : "";
    const noteSafe = note ? escapeHtml(note) : "";
    const row = document.createElement("div");
    row.className = "entry" + (id === editingEntryId ? " active" : "");
    row.innerHTML = `
      <div class="dot" style="background:${c.hex}"></div>
      <div class="info">
        <div class="time">${e.ts ? fmtTime(e.ts) : "—"} · ${valueToLabel(v)}</div>
        <div class="meta">Wert ${v}${sitSafe ? ` · ${sitSafe}` : ""}</div>
        ${noteSafe ? `<div class="note-indicator" title="${noteSafe}">${noteSafe}</div>` : ""}
      </div>
      <button class="del" title="Löschen">✕</button>
    `;
    row.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("del")) return;
      editingEntryId = id;
      setSliderToValue(v);
      updateFeel();
      if (e.ts) {
        const d = new Date(e.ts);
        timeInput.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      populateSituationOptions(sit);
      noteInput.value = note;
      updateNoteCount();
      renderEntryList(dk);
    });
    row.querySelector(".del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!confirm("Diesen Eintrag löschen?")) return;
      deleteEntry(dk, id);
      if (editingEntryId === id) editingEntryId = null;
    });
    entryList.appendChild(row);
  }
}

function genTempId() {
  if (crypto && crypto.randomUUID) return "local-" + crypto.randomUUID();
  return "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function saveEntry(dk, entryId, v, ts, situation, note) {
  if (!DATA[dk]) DATA[dk] = {};
  const cleanNote = (note || "").trim();
  if (entryId) {
    // Bearbeiten
    const updatePayload = { value: v, ts };
    updatePayload.situation = situation || null;
    updatePayload.note = cleanNote || null;
    // Lokal sofort anwenden (null = entfernen)
    DATA[dk][entryId] = { ...DATA[dk][entryId], value: v, ts };
    if (situation) DATA[dk][entryId].situation = situation;
    else delete DATA[dk][entryId].situation;
    if (cleanNote) DATA[dk][entryId].note = cleanNote;
    else delete DATA[dk][entryId].note;

    if (entryId.startsWith("local-")) {
      // Pending push-Op patchen statt neue Op zu erzeugen
      const p = pendingQueue.find(q => q.op === "push" && q.tempId === entryId);
      if (p) {
        p.payload = { value: v, ts };
        if (situation) p.payload.situation = situation;
        if (cleanNote) p.payload.note = cleanNote;
      }
    } else {
      pendingQueue.push({ op: "update", dk, entryId, payload: updatePayload });
    }
  } else {
    // Neu anlegen
    const tempId = genTempId();
    const payload = { value: v, ts };
    if (situation) payload.situation = situation;
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

document.getElementById("saveBtn").onclick = () => {
  if (!selectedDayKey) return;
  const v = sliderValue();
  const [hh, mm] = (timeInput.value || "12:00").split(":").map(Number);
  const d = parseDayKey(selectedDayKey);
  d.setHours(hh||0, mm||0, 0, 0);
  const ts = d.getTime();
  let situation = "";
  if (situationSelect.value === "__new__") {
    situation = situationInput.value.trim();
  } else {
    situation = situationSelect.value.trim();
  }
  const note = (noteInput.value || "").trim();
  saveEntry(selectedDayKey, editingEntryId, v, ts, situation, note);
  closeSheet();
};

/* ---------- Statistics ---------- */
function computeStats() {
  const dayKeys = Object.keys(DATA).sort();
  const dayAvgs = {};      // dk -> avg
  const allEntries = [];   // {dk, value, ts, situation}
  const bySituation = {};  // name -> { sum, count, values: [] }
  for (const dk of dayKeys) {
    const vals = [];
    for (const id in DATA[dk]) {
      const e = DATA[dk][id];
      const v = Number(e.value);
      if (isNaN(v)) continue;
      vals.push(v);
      const sit = (e.situation || "").trim();
      allEntries.push({ dk, id, value: v, ts: e.ts, situation: sit });
      if (sit) {
        if (!bySituation[sit]) bySituation[sit] = { sum: 0, count: 0 };
        bySituation[sit].sum += v;
        bySituation[sit].count += 1;
      }
    }
    if (vals.length) dayAvgs[dk] = avg(vals);
  }
  return { dayAvgs, allEntries, bySituation, dayKeys: Object.keys(dayAvgs).sort() };
}

/* Zeitliche Aggregate für Heute/Woche/Monat/Spektrum bündeln */
function computePeriodAggregates(stats) {
  const today = dayKey(new Date());
  const todayAvg = stats.dayAvgs[today] ?? null;
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-6);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate()-29);

  const weekAvgs = [], monthAvgs = [];
  for (const dk in stats.dayAvgs) {
    const d = parseDayKey(dk);
    if (d >= weekAgo) weekAvgs.push(stats.dayAvgs[dk]);
    if (d >= monthAgo) monthAvgs.push(stats.dayAvgs[dk]);
  }
  const allDayAvgs = Object.values(stats.dayAvgs);
  return {
    today, todayAvg,
    week: avg(weekAvgs), weekDays: weekAvgs.length,
    month: avg(monthAvgs), monthDays: monthAvgs.length,
    allDayAvgs,
    trackedDays: stats.dayKeys.length
  };
}

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

function computeFluidityIndex(stats) {
  const vals = Object.values(stats.dayAvgs);
  if (vals.length < 2) return { score: null, sd: 0, label: "noch zu wenig Daten" };
  const sd = stddev(vals);
  // SD-Maximum bei gleichmäßig oszillierenden 0/100-Tagen ist 50.
  const score = Math.max(0, Math.min(100, Math.round(sd / 50 * 100)));
  let label;
  if (score <= 20)      label = "sehr stabil";
  else if (score <= 40) label = "leicht fluid";
  else if (score <= 60) label = "fluid";
  else if (score <= 80) label = "sehr fluid";
  else                  label = "extrem fluid";
  return { score, sd, label };
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
  container.innerHTML = `
    <div class="fluidity-score">
      <div class="num">${f.score}</div>
      <div class="lbl">${f.label}</div>
      <div class="sub">σ = ${f.sd.toFixed(1)}</div>
      <div class="meter"><div style="width:${f.score}%"></div></div>
    </div>
    <div class="fluidity-explain">
      Dein Identitätsspektrum schwankt mit einem Index von <b>${f.score}/100</b>.
      Je höher der Wert, desto fluider bist du – statt eines starren Mittelwerts
      misst er die <b>Beweglichkeit</b> deiner Tageswerte.
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
  let f=0,n=0,m=0;
  for (const v of Object.values(stats.dayAvgs)) {
    const b = bucket(v);
    if (b==="f") f++; else if (b==="n") n++; else m++;
  }
  const total = f+n+m || 1;
  const bar = document.getElementById("bucketBar");
  bar.children[0].style.width = (f/total*100)+"%";
  bar.children[1].style.width = (n/total*100)+"%";
  bar.children[2].style.width = (m/total*100)+"%";
  setText("lbWF", `weiblich · ${Math.round(f/total*100)}% (${f}d)`);
  setText("lbFL", `fluid · ${Math.round(n/total*100)}% (${n}d)`);
  setText("lbML", `männlich · ${Math.round(m/total*100)}% (${m}d)`);

  // Swatches
  const today = dayKey(new Date());
  const todayAvg = stats.dayAvgs[today];
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-6);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate()-29);
  const weekVals=[], monthVals=[];
  for (const dk in stats.dayAvgs) {
    const d = parseDayKey(dk);
    if (d >= weekAgo) weekVals.push(stats.dayAvgs[dk]);
    if (d >= monthAgo) monthVals.push(stats.dayAvgs[dk]);
  }
  const all = avg(Object.values(stats.dayAvgs));
  function sw(label, v) {
    if (v == null || isNaN(v)) return `<div class="swatch" style="background:#2a1a44;color:#9b8fb5">
        <div class="swatch-label">${label}</div>
        <div class="swatch-val">keine Daten</div></div>`;
    const c = valueToColor(v);
    const dark = (c.r*299 + c.g*587 + c.b*114)/1000 > 150;
    const txt = dark ? "#1a0f29" : "#fff";
    return `<div class="swatch" style="background:${c.hex};color:${txt}">
      <div class="swatch-label">${label}</div>
      <div class="swatch-val">Wert ${v.toFixed(1)} · ${valueToLabel(v)}</div>
    </div>`;
  }
  document.getElementById("swatches").innerHTML = [
    sw("Heute", todayAvg),
    sw("Woche", avg(weekVals)),
    sw("Monat", avg(monthVals)),
    sw("All-Time", all)
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
    <path d="${path}" fill="none" stroke="url(#sg)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  `;
}

function renderHeatmap(stats) {
  const hm = document.getElementById("heatmap");
  hm.innerHTML = "";
  const end = new Date();
  const todayK = dayKey(end);
  const start = new Date(end); start.setMonth(start.getMonth()-12);
  // align start to Monday
  const offset = (start.getDay()+6)%7;
  start.setDate(start.getDate()-offset);
  const total = Math.ceil((end - start)/(1000*60*60*24)) + 7;
  for (let i=0;i<total;i++) {
    const d = new Date(start); d.setDate(start.getDate()+i);
    const dk = dayKey(d);
    const v = stats.dayAvgs[dk];
    const cell = document.createElement("div");
    cell.className = "hcell";
    const isFuture = dk > todayK;
    if (v != null) {
      const c = valueToColor(v);
      cell.style.background = c.hex;
      cell.title = `${dk} · ${v.toFixed(1)} · ${valueToLabel(v)}`;
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
  const names = ["Mo","Di","Mi","Do","Fr","Sa","So"];
  const sums = new Array(7).fill(0), cnts = new Array(7).fill(0);
  for (const dk in stats.dayAvgs) {
    const d = parseDayKey(dk);
    const w = (d.getDay()+6)%7;
    sums[w] += stats.dayAvgs[dk]; cnts[w]++;
  }
  const row = document.getElementById("weekdayRow");
  row.innerHTML = "";
  for (let i=0;i<7;i++) {
    const v = cnts[i] ? sums[i]/cnts[i] : null;
    const c = v != null ? valueToColor(v) : null;
    const div = document.createElement("div");
    div.className = "wd";
    div.innerHTML = `
      <div class="n">${names[i]}</div>
      <div class="v" style="${c?`color:${c.hex}`:''}">${v!=null?v.toFixed(1):"—"}</div>
      <div class="sw" style="background:${c?c.hex:'rgba(255,255,255,0.06)'}"></div>
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
    const consecutive = prev && ((d - prev)/(1000*60*60*24) === 1);
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
  // Min / Max
  let minDay=null, maxDay=null;
  for (const dk in stats.dayAvgs) {
    const v = stats.dayAvgs[dk];
    if (minDay===null || v < stats.dayAvgs[minDay]) minDay = dk;
    if (maxDay===null || v > stats.dayAvgs[maxDay]) maxDay = dk;
  }
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
  document.getElementById("streakStats").innerHTML = [
    cell("Längste ♀-Serie", longestF + " Tage", "in Folge", "var(--pink)"),
    cell("Längste ⚧-Serie", longestFL + " Tage", "fluid in Folge", "var(--neutral)"),
    cell("Längste ♂-Serie", longestM + " Tage", "in Folge", "var(--blue)"),
    cell("Volatilität σ", vol.toFixed(1), "Streuung Tageswerte"),
    cell("Weiblichster Tag", minDay ? stats.dayAvgs[minDay].toFixed(1) : "—", fmtDay(minDay), minColor),
    cell("Männlichster Tag", maxDay ? stats.dayAvgs[maxDay].toFixed(1) : "—", fmtDay(maxDay), maxColor),
    cell("Trend 30d " + trendArrow, slope.toFixed(2) + "/d", trendDir),
    cell("Top-Tageszeit", topPart, topPartCnt + " Check-ins")
  ].join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[ch]));
}

function renderSituationStats(stats) {
  const container = document.getElementById("situationStats");
  const entries = Object.entries(stats.bySituation)
    .map(([name, agg]) => ({ name, avg: agg.sum / agg.count, count: agg.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"));

  if (!entries.length) {
    container.innerHTML = `<div class="sit-empty">Noch keine Situationen erfasst — füge im Check-in eine hinzu.</div>`;
    return;
  }

  container.innerHTML = entries.map(({ name, avg, count }) => {
    const c = valueToColor(avg);
    const pct = Math.max(0, Math.min(100, avg));
    return `
      <div class="sit-row">
        <div class="sit-head">
          <span class="sit-name">${escapeHtml(name)}</span>
          <span class="sit-count">${count}×</span>
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

  // 1) Situations-Extremes (high vs low Ø, beide N >= 5)
  const sitEntries = Object.entries(stats.bySituation)
    .map(([name, agg]) => ({ name, avg: agg.sum / agg.count, count: agg.count }))
    .filter(e => e.count >= 5);
  if (sitEntries.length >= 2) {
    const sorted = [...sitEntries].sort((a, b) => a.avg - b.avg);
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const diff = hi.avg - lo.avg;
    if (diff >= 5) {
      out.push({
        weight: 90 + Math.min(20, diff),
        color: valueToColor((lo.avg + hi.avg) / 2).hex,
        text: `Bei <b>${escapeHtml(hi.name)}</b> fühlst du dich Ø <b>${diff.toFixed(0)} Punkte männlicher</b> als bei <b>${escapeHtml(lo.name)}</b>.`
      });
    }
  }

  // 2) Wochenende vs. Werktag (Ø der Tage, jeweils N >= 6)
  const weVals = [], wdVals = [];
  for (const dk in dayAvgs) {
    const d = parseDayKey(dk);
    const w = d.getDay();
    (w === 0 || w === 6 ? weVals : wdVals).push(dayAvgs[dk]);
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
      if ((prev - d) / 86400000 !== 1) break;
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

  // 6) Konsistenteste Situation (niedrigstes σ, N >= 5)
  const sitWithSigma = Object.entries(stats.bySituation)
    .filter(([, agg]) => agg.count >= 5)
    .map(([name, agg]) => {
      // Sigma aus allEntries für diese Situation berechnen
      const vals = stats.allEntries.filter(e => e.situation === name).map(e => e.value);
      return { name, sigma: stddev(vals), count: agg.count };
    })
    .filter(s => s.sigma > 0)
    .sort((a, b) => a.sigma - b.sigma);
  if (sitWithSigma.length >= 2 && sitWithSigma[0].sigma < sitWithSigma[1].sigma * 0.75) {
    const top = sitWithSigma[0];
    out.push({
      weight: 55,
      color: "#c79bd0",
      text: `<b>${escapeHtml(top.name)}</b> ist deine konsistenteste Situation (σ ${top.sigma.toFixed(0)}).`
    });
  }

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
  if (dayKeysSorted.length >= 3) {
    let minDay = null, maxDay = null;
    for (const dk of dayKeysSorted) {
      const v = dayAvgs[dk];
      if (minDay === null || v < dayAvgs[minDay]) minDay = dk;
      if (maxDay === null || v > dayAvgs[maxDay]) maxDay = dk;
    }
    const todayK = dayKey(new Date());
    const daysAgo = (dk) => Math.round((parseDayKey(todayK) - parseDayKey(dk)) / 86400000);
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
    container.innerHTML = `<li class="insight insight-empty">Noch zu wenig Daten für Muster. Trag ein paar Tage mit Situationen ein — dann tauchen hier Beobachtungen auf.</li>`;
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
  const stats = computeStats();
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
  renderSituationStats(stats);
  renderInsights(stats);
  renderStreaks(stats);
  if (sheet.classList.contains("open")) populateSituationOptions(situationSelect.value && situationSelect.value !== "__new__" ? situationSelect.value : "");
  if (selectedDayKey) renderEntryList(selectedDayKey);
}

/* FAB für Quick-Check-in */
document.getElementById("quickCheckin").addEventListener("click", () => {
  openSheet(dayKey(new Date()));
});

// First paint before data arrives
updateFeel();
renderAll();
