/* UI-Schicht: Sheet, Slider, FAB, Toasts, Tag-Selects, Soft-Delete-Undo,
   Info-Karten. Mutiert state.data und state.pendingQueue, ruft danach
   notify() für Re-Render. */

import { state, canWrite, notify } from "./state.js";
import { saveLocal, savePending, updateStatus, flushPending, exportData } from "./sync.js";
import { dayKey, parseDayKey } from "./stats.js";
import {
  SCALE, scaleIndexFromValue,
  valueToColor, valueToSymbol, valueToLabel,
  pad, fmtTime, escapeHtml
} from "./format.js";

/* ---------- Haptik (#37) ----------
   Web Vibration API. Wird auf iOS still ignoriert (kein Support) —
   auf Android löst sie ein sehr kurzes Tactile-Feedback aus.
   Bei prefers-reduced-motion: reduce komplett überspringen, weil
   manche Nutzer*innen Vibration ebenfalls als störend empfinden. */
const _prefersReducedMotion = (() => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)"); }
  catch { return { matches: false }; }
})();

function haptic(kind) {
  if (!("vibrate" in navigator)) return;
  if (_prefersReducedMotion.matches) return;
  try {
    if (kind === "save")   navigator.vibrate(12);
    else if (kind === "delete") navigator.vibrate(20);
    else if (kind === "error")  navigator.vibrate([8, 40, 8]);
  } catch {}
}

/* ---------- DOM-Refs (nach initUi gesetzt) ---------- */
let backdrop, sheet, slider;
let feelSym, feelLabel, feelVal;
let timeInput, sheetTitle, sheetSubtitle;
let entryList, entriesTitle;
let ortSelect, ortInput, befindenSelect, befindenInput;
let sliderTicks, noteInput, noteCount;
let exportBtn;

/* ---------- Toasts ----------
   Wichtige Toasts (z.B. Undo) dürfen nicht von beiläufigen Sync-Toasts
   zerstört werden. Vor jedem neuen Toast wird ein evtl. schwebender
   Soft-Delete sofort committet, damit der Snapshot nicht in einem
   inkonsistenten Zustand verloren geht. */
export function showToast(text, actionLabel, onAction, timeoutMs = 5000, onTimeout = null, opts = {}) {
  const container = document.getElementById("toasts");
  if (!container) { if (onTimeout) onTimeout(); return null; }
  if (!opts.important && pendingDeleteSnapshot) {
    finalizePendingDelete();
  }
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

let lastSyncErrorToastAt = 0;
const SYNC_ERROR_TOAST_COOLDOWN_MS = 30000;
export function notifySyncIssue(text) {
  const now = Date.now();
  if (now - lastSyncErrorToastAt < SYNC_ERROR_TOAST_COOLDOWN_MS) return;
  lastSyncErrorToastAt = now;
  showToast(text, null, null, 4000);
  haptic("error");
}

/* ---------- Sheet / Check-in ---------- */
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
  feelSym.style.transform = `scale(${1 + Math.abs(v - 50) / 200})`;
  sheet.style.boxShadow = `0 30px 80px rgba(0,0,0,0.55), 0 0 0 2px rgba(${c.r},${c.g},${c.b},0.35), 0 0 60px rgba(${c.r},${c.g},${c.b},0.25)`;
}

function updateNoteCount() {
  const len = (noteInput.value || "").length;
  noteCount.textContent = String(len);
  noteCount.parentElement.classList.toggle("near-limit", len >= 220);
}

function collectKnownTagValues(key) {
  const set = new Set();
  for (const dk in state.data) {
    for (const id in state.data[dk]) {
      const e = state.data[dk][id];
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

export function populateOrtOptions(selected) {
  populateTagSelect(ortSelect, ortInput, collectKnownTagValues("ort"), "— keiner —", "+ neuer Ort…", selected);
}
export function populateBefindenOptions(selected) {
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

export function openSheet(dk) {
  if (!canWrite()) return;
  state.selectedDayKey = dk;
  state.editingEntryId = null;
  const d = parseDayKey(dk);
  const isToday = dk === dayKey(new Date());
  sheetTitle.textContent = isToday ? "Heutiger Check-in" : `Check-in · ${d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
  sheetSubtitle.textContent = isToday ? "Wie fühlst du dich gerade?" : "Eintrag rückwirkend erfassen oder bearbeiten.";
  const entries = state.data[dk] ? Object.entries(state.data[dk]).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0)) : [];
  const lastVal = entries.length ? Number(entries[entries.length - 1][1].value) : NaN;
  const seed = Number.isFinite(lastVal) ? lastVal : 50;
  setSliderToValue(seed);
  updateFeel();
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
  state.selectedDayKey = null;
  state.editingEntryId = null;
}

/* A11y: Fokus innerhalb des offenen Sheets halten (Tab-Falle). */
function focusableInSheet() {
  return Array.from(sheet.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null);
}

export function renderEntryList(dk) {
  const entries = state.data[dk] ? Object.entries(state.data[dk]) : [];
  entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
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
    row.className = "entry" + (id === state.editingEntryId ? " active" : "");
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
      state.editingEntryId = id;
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
  if (!state.data[dk]) state.data[dk] = {};
  const cleanNote = (note || "").trim();
  if (entryId) {
    const updatePayload = { value: v, ts };
    updatePayload.ort = ort || null;
    updatePayload.befinden = befinden || null;
    updatePayload.note = cleanNote || null;
    // Falls dieser Eintrag noch legacy `situation` hat, beim Update wegräumen,
    // damit Ort eindeutig bleibt.
    if (state.data[dk][entryId] && state.data[dk][entryId].situation !== undefined) {
      updatePayload.situation = null;
    }
    state.data[dk][entryId] = { ...state.data[dk][entryId], value: v, ts };
    delete state.data[dk][entryId].situation;
    if (ort) state.data[dk][entryId].ort = ort;
    else delete state.data[dk][entryId].ort;
    if (befinden) state.data[dk][entryId].befinden = befinden;
    else delete state.data[dk][entryId].befinden;
    if (cleanNote) state.data[dk][entryId].note = cleanNote;
    else delete state.data[dk][entryId].note;

    if (entryId.startsWith("local-")) {
      // Pending push-Op patchen statt neue Op zu erzeugen
      const p = state.pendingQueue.find(q => q.op === "push" && q.tempId === entryId);
      if (p) {
        p.payload = { value: v, ts };
        if (ort) p.payload.ort = ort;
        if (befinden) p.payload.befinden = befinden;
        if (cleanNote) p.payload.note = cleanNote;
      }
    } else {
      const hasPendingDelete = state.pendingQueue.some(
        q => q.op === "delete" && q.entryId === entryId && q.dk === dk
      );
      if (!hasPendingDelete) {
        // Aufeinanderfolgende Updates für denselben Eintrag in eine Op mergen.
        const prev = state.pendingQueue.find(
          q => q.op === "update" && q.entryId === entryId && q.dk === dk
        );
        if (prev) {
          prev.payload = { ...prev.payload, ...updatePayload };
        } else {
          state.pendingQueue.push({ op: "update", dk, entryId, payload: updatePayload });
        }
      }
    }
  } else {
    const tempId = genTempId();
    const payload = { value: v, ts };
    if (ort) payload.ort = ort;
    if (befinden) payload.befinden = befinden;
    if (cleanNote) payload.note = cleanNote;
    state.data[dk][tempId] = payload;
    state.pendingQueue.push({ op: "push", tempId, dk, payload });
  }
  saveLocal();
  savePending();
  updateStatus();
  notify();
  haptic("save");
  flushPending();
}

/* ---------- Soft-Delete mit Undo ---------- */
const UNDO_MS = 5000;
let pendingDeleteTimer = null;
let pendingDeleteSnapshot = null;

function requestDeleteWithUndo(dk, entryId) {
  if (!canWrite()) return;
  if (!state.data[dk] || !state.data[dk][entryId]) return;
  // Falls noch ein anderes Soft-Delete läuft, dieses jetzt definitiv committen
  finalizePendingDelete();

  pendingDeleteSnapshot = { dk, entryId, entry: { ...state.data[dk][entryId] } };
  delete state.data[dk][entryId];
  if (!Object.keys(state.data[dk]).length) delete state.data[dk];
  if (state.editingEntryId === entryId) state.editingEntryId = null;
  saveLocal();
  notify();
  haptic("delete");

  pendingDeleteTimer = showToast("Eintrag gelöscht", "Rückgängig", () => {
    const s = pendingDeleteSnapshot;
    pendingDeleteSnapshot = null;
    pendingDeleteTimer = null;
    if (!s) return;
    if (!state.data[s.dk]) state.data[s.dk] = {};
    state.data[s.dk][s.entryId] = s.entry;
    saveLocal();
    notify();
  }, UNDO_MS, finalizePendingDelete, { important: true });
}

export function finalizePendingDelete() {
  if (!pendingDeleteSnapshot) return;
  const { dk, entryId } = pendingDeleteSnapshot;
  pendingDeleteSnapshot = null;
  clearTimeout(pendingDeleteTimer); pendingDeleteTimer = null;
  if (entryId.startsWith("local-")) {
    state.pendingQueue = state.pendingQueue.filter(q => !(q.op === "push" && q.tempId === entryId));
  } else {
    state.pendingQueue = state.pendingQueue.filter(q => !(q.op === "update" && q.entryId === entryId));
    state.pendingQueue.push({ op: "delete", dk, entryId });
  }
  savePending();
  updateStatus();
  flushPending();
}

/* ---------- Init ---------- */
export function initUi() {
  backdrop = document.getElementById("backdrop");
  sheet = document.getElementById("sheet");
  slider = document.getElementById("slider");
  feelSym = document.getElementById("feelSym");
  feelLabel = document.getElementById("feelLabel");
  feelVal = document.getElementById("feelVal");
  timeInput = document.getElementById("timeInput");
  sheetTitle = document.getElementById("sheetTitle");
  sheetSubtitle = document.getElementById("sheetSubtitle");
  entryList = document.getElementById("entryList");
  entriesTitle = document.getElementById("entriesTitle");
  ortSelect = document.getElementById("ortSelect");
  ortInput = document.getElementById("ortInput");
  befindenSelect = document.getElementById("befindenSelect");
  befindenInput = document.getElementById("befindenInput");
  sliderTicks = document.getElementById("sliderTicks");
  noteInput = document.getElementById("noteInput");
  noteCount = document.getElementById("noteCount");
  exportBtn = document.getElementById("exportBtn");

  // Slider-Ticks einmalig erzeugen
  sliderTicks.innerHTML = SCALE.map(s => `<span>${s.tick}</span>`).join("");

  slider.addEventListener("input", updateFeel);
  noteInput.addEventListener("input", updateNoteCount);
  wireTagSelect(ortSelect, ortInput);
  wireTagSelect(befindenSelect, befindenInput);

  // Tab-Falle + ESC im Sheet
  document.addEventListener("keydown", (ev) => {
    if (!sheet.classList.contains("open")) return;
    if (ev.key === "Escape") { ev.preventDefault(); closeSheet(); return; }
    if (ev.key !== "Tab") return;
    const items = focusableInSheet();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  backdrop.onclick = closeSheet;
  document.getElementById("cancelBtn").onclick = closeSheet;
  document.getElementById("nowBtn").onclick = () => {
    const n = new Date();
    timeInput.value = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
  };

  document.getElementById("saveBtn").onclick = () => {
    if (!canWrite()) return;
    if (!state.selectedDayKey) return;
    const v = sliderValue();
    const [rawHh, rawMm] = (timeInput.value || "12:00").split(":").map(Number);
    const hh = Number.isFinite(rawHh) ? Math.max(0, Math.min(23, rawHh)) : 12;
    const mm = Number.isFinite(rawMm) ? Math.max(0, Math.min(59, rawMm)) : 0;
    const d = parseDayKey(state.selectedDayKey);
    d.setHours(hh, mm, 0, 0);
    const ts = d.getTime();
    const readTag = (selectEl, inputEl) =>
      selectEl.value === "__new__" ? inputEl.value.trim() : selectEl.value.trim();
    const ort = readTag(ortSelect, ortInput);
    const befinden = readTag(befindenSelect, befindenInput);
    const note = (noteInput.value || "").trim();
    saveEntry(state.selectedDayKey, state.editingEntryId, v, ts, ort, befinden, note);
    closeSheet();
  };

  if (exportBtn) exportBtn.addEventListener("click", exportData);

  /* Falls der User die Seite verlässt während ein Soft-Delete schwebt: jetzt committen */
  window.addEventListener("beforeunload", finalizePendingDelete);

  /* Month-Nav-Buttons */
  document.getElementById("prevMonth").onclick = () => {
    state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() - 1, 1);
    notify();
  };
  document.getElementById("nextMonth").onclick = () => {
    state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 1);
    notify();
  };
  document.getElementById("todayBtn").onclick = () => {
    state.viewDate = new Date();
    notify();
  };

  /* FAB für Quick-Check-in */
  document.getElementById("quickCheckin").addEventListener("click", () => {
    openSheet(dayKey(new Date()));
  });

  /* FAB beim Runter-Scrollen ausblenden (nur Mobile / Touch) */
  initFabScrollHide();

  /* Info-Karten (<details class="info">): explizites Toggle statt nativem.
     Vermeidet Race-Conditions zwischen Default-Action und Click-Listener,
     und sorgt für deterministisches Schließen auf Desktop UND Touch. */
  initInfoCards();

  // First paint des Slider-Feel-Anzeige (vor erstem Daten-Render).
  updateFeel();
}

function initFabScrollHide() {
  const fab = document.getElementById("quickCheckin");
  if (!fab) return;
  const mq = window.matchMedia("(max-width: 640px), (hover: none)");
  let lastY = window.scrollY;
  let ticking = false;
  const SHOW_THRESHOLD = 6;
  const HIDE_THRESHOLD = 10;
  const onScroll = () => {
    if (!mq.matches) { fab.classList.remove("fab--hidden"); ticking = false; return; }
    const y = window.scrollY;
    const dy = y - lastY;
    if (y < 80) {
      fab.classList.remove("fab--hidden");
    } else if (dy > HIDE_THRESHOLD) {
      fab.classList.add("fab--hidden");
      lastY = y;
    } else if (dy < -SHOW_THRESHOLD) {
      fab.classList.remove("fab--hidden");
      lastY = y;
    }
    ticking = false;
  };
  window.addEventListener("scroll", () => {
    if (!ticking) { requestAnimationFrame(onScroll); ticking = true; }
  }, { passive: true });
  mq.addEventListener?.("change", () => {
    if (!mq.matches) fab.classList.remove("fab--hidden");
  });
}

function initInfoCards() {
  function closeAll() {
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
      closeAll();
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
    if (ev.key === "Escape") closeAll();
  });
}

/* Re-Render-Hook für Sheet-Tag-Selects nach externen Daten-Updates.
   Wird aus render.js nach renderAll() aufgerufen. */
export function syncSheetAfterRender() {
  if (!sheet || !sheet.classList.contains("open")) return;
  const keepOrt = ortSelect.value && ortSelect.value !== "__new__" ? ortSelect.value : "";
  const keepBef = befindenSelect.value && befindenSelect.value !== "__new__" ? befindenSelect.value : "";
  populateOrtOptions(keepOrt);
  populateBefindenOptions(keepBef);
  if (state.selectedDayKey) renderEntryList(state.selectedDayKey);
}
