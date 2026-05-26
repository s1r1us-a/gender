/* UI-Schicht: Sheet, Slider, FAB, Toasts, Tag-Selects, Soft-Delete-Undo,
   Info-Karten. Mutiert state.data und state.pendingQueue, ruft danach
   notify() für Re-Render. */

import { state, canWrite, notify } from "./state.js";
import { saveLocal, savePending, updateStatus, flushPending, exportData } from "./sync.js";
import { dayKey, parseDayKey } from "./stats.js";
import {
  SCALE, scaleIndexFromValue,
  valueToColor, valueToSymbol, valueToLabel,
  pad, fmtTime, escapeHtml, normalizeTags
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
let ortSelect, ortInput;
let befindenChips, befindenNewInput;
let begleitungChips, begleitungNewInput;
let sliderTicks, noteInput, noteCount;
let exportBtn;
let saveBtn, cancelBtn, nowBtn;
let modeBanner, modeBannerIcon, modeBannerTitle, modeBannerSub, modeBannerDirty;
let modeResetLink, entryResetRow, newEntryBtn;
let confirmOverlay, confirmTitleEl, confirmBody, confirmNote, confirmCancel, confirmOk;

/* Snapshot der Form-Werte beim Öffnen / Wechseln des Eintrags.
   Wird für Dirty-Detection bei Schließen / Switch / Reset verwendet. */
let sheetInitial = null;

/* Aktuelle Mehrfach-Auswahl im offenen Sheet. Wird beim Öffnen / Wechsel
   des Eintrags neu befüllt und beim Speichern in Array/String/null
   umgewandelt. */
const selectedBefinden = new Set();
const selectedBegleitung = new Set();

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
      if (key === "ort") {
        // Ort liest legacy `situation` mit, damit bestehende Werte auftauchen.
        const s = ((e.ort ?? e.situation) || "").trim();
        if (s) set.add(s);
      } else {
        // befinden / begleitung können String ODER Array sein
        for (const tag of normalizeTags(e[key])) set.add(tag);
      }
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

/* ---------- Chip-basiertes Mehrfach-Tag-Eingabefeld ----------
   `container` ist ein <div class="tag-chips">. Für jedes bekannte Tag
   wird ein Button-Chip erzeugt; in `selected` enthaltene Tags bekommen
   die Klasse `selected`. Tap → toggle. Ein zusätzlicher `+ neu`-Chip
   blendet das mitgegebene Input-Feld ein; Enter/Blur fügt den Wert in
   `selected` ein und re-rendert. DOM-API statt innerHTML — User-
   Strings werden so nie als HTML interpretiert. */
function renderChipGroup(container, newInput, knownAll, selected, newLabel) {
  container.replaceChildren();
  // Reihenfolge: zuerst ausgewählte (auch unbekannte / frisch hinzugefügte),
  // dann der Rest alphabetisch.
  const allSet = new Set(knownAll);
  for (const s of selected) allSet.add(s);
  const all = Array.from(allSet).sort((a, b) => a.localeCompare(b, "de"));

  for (const tag of all) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (selected.has(tag) ? " selected" : "");
    btn.dataset.value = tag;
    btn.setAttribute("aria-pressed", selected.has(tag) ? "true" : "false");
    btn.textContent = tag;
    btn.addEventListener("click", () => {
      if (selected.has(tag)) selected.delete(tag);
      else selected.add(tag);
      renderChipGroup(container, newInput, knownAll, selected, newLabel);
      refreshDirtyIndicator();
    });
    container.append(btn);
  }
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "chip chip-new";
  addBtn.textContent = newLabel;
  addBtn.addEventListener("click", () => {
    newInput.hidden = false;
    newInput.value = "";
    requestAnimationFrame(() => { try { newInput.focus(); } catch (_) {} });
  });
  container.append(addBtn);
}

function commitNewChip(newInput, container, knownAll, selected, newLabel) {
  const val = (newInput.value || "").trim();
  newInput.value = "";
  newInput.hidden = true;
  if (!val) return;
  selected.add(val);
  // Neuer Tag soll sofort im Vorrat erscheinen.
  if (!knownAll.includes(val)) knownAll.push(val);
  renderChipGroup(container, newInput, knownAll, selected, newLabel);
  /* Sichtbares Feedback: kurz animierter Pop am neuen Chip, leichte Vibration. */
  const justAdded = container.querySelector(`.chip[data-value="${CSS.escape(val)}"]`);
  if (justAdded) {
    justAdded.classList.add("chip-just-added");
    setTimeout(() => justAdded.classList.remove("chip-just-added"), 500);
  }
  haptic("save");
  refreshDirtyIndicator();
}

function wireNewInput(newInput, container, getKnown, selected, newLabel) {
  newInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitNewChip(newInput, container, getKnown(), selected, newLabel);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      newInput.value = "";
      newInput.hidden = true;
    }
  });
  newInput.addEventListener("blur", () => {
    commitNewChip(newInput, container, getKnown(), selected, newLabel);
  });
}

export function populateBefindenChips() {
  renderChipGroup(
    befindenChips, befindenNewInput,
    collectKnownTagValues("befinden"),
    selectedBefinden,
    "+ neu"
  );
}
export function populateBegleitungChips() {
  renderChipGroup(
    begleitungChips, begleitungNewInput,
    collectKnownTagValues("begleitung"),
    selectedBegleitung,
    "+ neu"
  );
}

/* ---------- Confirm-Modal (generisch) ---------- */
let _confirmOpen = false;
let _confirmOnOk = null;
let _confirmPrevFocus = null;

/* Öffnet ein blockierendes Bestätigungs-Modal.
   opts: { title, bodyHtml, summaryNode?, noteText?, confirmLabel, danger, onConfirm } */
function openConfirm(opts) {
  if (_confirmOpen) return; // Re-Entrancy verhindern
  _confirmOpen = true;
  _confirmOnOk = typeof opts.onConfirm === "function" ? opts.onConfirm : null;
  _confirmPrevFocus = document.activeElement;

  confirmTitleEl.textContent = opts.title || "Bestätigen?";
  /* Body wird als Sicherheits-Vorsichtsmaßnahme entweder als Text oder als
     vorbereiteter DOM-Knoten gesetzt — niemals roh aus User-Input gebaut. */
  confirmBody.replaceChildren();
  if (opts.bodyHtml) {
    const p = document.createElement("p");
    p.textContent = opts.bodyHtml;
    confirmBody.append(p);
  }
  if (opts.summaryNode) confirmBody.append(opts.summaryNode);

  if (opts.noteText) {
    confirmNote.textContent = opts.noteText;
    confirmNote.hidden = false;
  } else {
    confirmNote.hidden = true;
    confirmNote.textContent = "";
  }

  confirmOk.textContent = opts.confirmLabel || "Bestätigen";
  confirmOverlay.classList.toggle("is-danger", !!opts.danger);
  confirmOk.classList.toggle("is-danger", !!opts.danger);
  confirmOverlay.hidden = false;
  document.body.classList.add("modal-open");

  /* Sicherer Default-Fokus: Cancel (nicht der gefährliche Button). */
  requestAnimationFrame(() => { try { confirmCancel.focus(); } catch (_) {} });
}

function closeConfirm(invokeOk) {
  if (!_confirmOpen) return;
  const cb = _confirmOnOk;
  _confirmOpen = false;
  _confirmOnOk = null;
  confirmOverlay.hidden = true;
  /* Body-Modal-Open-Class nur entfernen, wenn das Sheet auch zu ist. */
  if (!sheet.classList.contains("open")) {
    document.body.classList.remove("modal-open");
  }
  if (invokeOk && cb) {
    try { cb(); } catch (e) { console.error(e); }
  }
  /* Fokus zurück auf den Auslöser, falls noch im DOM. */
  if (_confirmPrevFocus && document.contains(_confirmPrevFocus)) {
    try { _confirmPrevFocus.focus(); } catch (_) {}
  }
  _confirmPrevFocus = null;
}

/* ---------- Dirty-State ---------- */
function readFormSnapshot() {
  const readSelectTag = (selectEl, inputEl) =>
    selectEl.value === "__new__" ? (inputEl.value || "").trim() : (selectEl.value || "").trim();
  return {
    value: sliderValue(),
    time: timeInput.value || "",
    ort: readSelectTag(ortSelect, ortInput),
    befinden: Array.from(selectedBefinden).sort(),
    begleitung: Array.from(selectedBegleitung).sort(),
    note: (noteInput.value || "").trim(),
    pendingBef: (befindenNewInput.value || "").trim(),
    pendingBegl: (begleitungNewInput.value || "").trim(),
  };
}

function arrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isSheetDirty() {
  if (!sheetInitial) return false;
  const now = readFormSnapshot();
  return (
    now.value !== sheetInitial.value ||
    now.time !== sheetInitial.time ||
    now.ort !== sheetInitial.ort ||
    !arrEq(now.befinden, sheetInitial.befinden) ||
    !arrEq(now.begleitung, sheetInitial.begleitung) ||
    now.note !== sheetInitial.note ||
    now.pendingBef !== "" ||
    now.pendingBegl !== ""
  );
}

function refreshDirtyIndicator() {
  if (!modeBannerDirty) return;
  modeBannerDirty.hidden = !isSheetDirty();
}

/* ---------- Modus-Banner ---------- */
function updateModeBanner() {
  if (!modeBanner) return;
  const dk = state.selectedDayKey;
  const editingId = state.editingEntryId;
  const isEdit = !!(dk && editingId && state.data[dk] && state.data[dk][editingId]);
  modeBanner.dataset.mode = isEdit ? "edit" : "new";
  if (isEdit) {
    const e = state.data[dk][editingId];
    const v = Number(e.value);
    const lbl = valueToLabel(v);
    const sym = valueToSymbol(v);
    const when = e.ts ? fmtTime(e.ts) : "—";
    modeBannerIcon.textContent = "✏️";
    modeBannerTitle.textContent = "Eintrag bearbeiten";
    modeBannerSub.textContent = `${when} · ${sym} ${lbl} (${v})`;
    entryResetRow.hidden = false;
    modeResetLink.hidden = false;
    modeResetLink.textContent = `↺ Original (${v})`;
    saveBtn.textContent = "Änderungen speichern";
  } else {
    modeBannerIcon.textContent = "🆕";
    modeBannerTitle.textContent = "Neuer Eintrag";
    const isToday = dk === dayKey(new Date());
    modeBannerSub.textContent = isToday
      ? "Heute · wird als neuer Check-in angelegt"
      : (dk
        ? `${parseDayKey(dk).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })} · rückwirkender Eintrag`
        : "");
    entryResetRow.hidden = true;
    modeResetLink.hidden = true;
    saveBtn.textContent = "Eintrag speichern";
  }
  refreshDirtyIndicator();
}

/* ---------- Summary-Builder fürs Confirm-Modal ---------- */
function makeSummaryRow(key, valNode) {
  const row = document.createElement("div");
  row.className = "cs-row";
  const k = document.createElement("div");
  k.className = "cs-key";
  k.textContent = key;
  const v = document.createElement("div");
  v.className = "cs-val";
  if (typeof valNode === "string") v.textContent = valNode;
  else v.append(valNode);
  row.append(k, v);
  return row;
}

function emText(text) {
  const em = document.createElement("em");
  em.textContent = text;
  return em;
}

/* Diff-Wert: zeigt alt → neu, falls verschieden. */
function diffSpan(oldVal, newVal) {
  const wrap = document.createElement("span");
  const same = oldVal === newVal;
  if (same) {
    const s = document.createElement("span");
    s.className = "same";
    s.textContent = newVal || "—";
    wrap.append(s);
  } else {
    if (oldVal) {
      const o = document.createElement("span");
      o.className = "old";
      o.textContent = oldVal;
      wrap.append(o);
    }
    const n = document.createElement("span");
    n.className = "new changed";
    n.textContent = newVal || "—";
    wrap.append(n);
  }
  return wrap;
}

function tagsText(arr) {
  return arr.length ? arr.join(", ") : "";
}

function buildSaveSummary(opts) {
  /* opts: { isEdit, oldEntry, newValues:{ value, time, ort, befinden, begleitung, note }, dkLabel } */
  const wrap = document.createElement("div");
  wrap.className = "confirm-summary";
  const head = document.createElement("div");
  head.className = "cs-head";
  head.textContent = opts.isEdit ? "Was sich ändert" : "Was gespeichert wird";
  wrap.append(head);

  const nv = opts.newValues;
  const sym = valueToSymbol(nv.value);
  const lbl = valueToLabel(nv.value);
  const valTxt = `${sym} ${lbl} (${nv.value})`;

  if (opts.isEdit) {
    const old = opts.oldEntry || {};
    const oldVal = Number(old.value);
    const oldValTxt = Number.isFinite(oldVal) ? `${valueToSymbol(oldVal)} ${valueToLabel(oldVal)} (${oldVal})` : "";
    wrap.append(makeSummaryRow("Wert", diffSpan(oldValTxt, valTxt)));

    const oldTime = old.ts ? fmtTime(old.ts) : "";
    wrap.append(makeSummaryRow("Uhrzeit", diffSpan(oldTime, nv.time || "—")));

    const oldOrt = ((old.ort ?? old.situation) || "").trim();
    wrap.append(makeSummaryRow("Ort", diffSpan(oldOrt, nv.ort)));

    const oldBef = normalizeTags(old.befinden).slice().sort();
    const newBef = nv.befinden.slice().sort();
    wrap.append(makeSummaryRow("Befinden", diffSpan(tagsText(oldBef), tagsText(newBef))));

    const oldBegl = normalizeTags(old.begleitung).slice().sort();
    const newBegl = nv.begleitung.slice().sort();
    wrap.append(makeSummaryRow("Begleitung", diffSpan(tagsText(oldBegl), tagsText(newBegl))));

    const oldNote = (old.note || "").trim();
    wrap.append(makeSummaryRow("Notiz", diffSpan(oldNote, nv.note)));
  } else {
    wrap.append(makeSummaryRow("Datum", opts.dkLabel || ""));
    wrap.append(makeSummaryRow("Wert", valTxt));
    wrap.append(makeSummaryRow("Uhrzeit", nv.time || emText("(keine)")));
    wrap.append(makeSummaryRow("Ort", nv.ort || emText("(keiner)")));
    wrap.append(makeSummaryRow("Befinden", tagsText(nv.befinden) || emText("(keins)")));
    wrap.append(makeSummaryRow("Begleitung", tagsText(nv.begleitung) || emText("(keine)")));
    wrap.append(makeSummaryRow("Notiz", nv.note || emText("(keine)")));
  }
  return wrap;
}

function buildDeleteSummary(entry) {
  const wrap = document.createElement("div");
  wrap.className = "confirm-summary";
  const head = document.createElement("div");
  head.className = "cs-head";
  head.textContent = "Dieser Eintrag wird gelöscht";
  wrap.append(head);

  const v = Number(entry.value);
  const valTxt = Number.isFinite(v) ? `${valueToSymbol(v)} ${valueToLabel(v)} (${v})` : "—";
  wrap.append(makeSummaryRow("Wert", valTxt));
  wrap.append(makeSummaryRow("Uhrzeit", entry.ts ? fmtTime(entry.ts) : "—"));

  const ort = ((entry.ort ?? entry.situation) || "").trim();
  wrap.append(makeSummaryRow("Ort", ort || emText("(keiner)")));

  const bef = normalizeTags(entry.befinden);
  wrap.append(makeSummaryRow("Befinden", tagsText(bef) || emText("(keins)")));

  const begl = normalizeTags(entry.begleitung);
  wrap.append(makeSummaryRow("Begleitung", tagsText(begl) || emText("(keine)")));

  const note = (entry.note || "").trim();
  wrap.append(makeSummaryRow("Notiz", note || emText("(keine)")));
  return wrap;
}

/* ---------- Form-Reset / Population (zentrale Helfer) ---------- */
function populateFormFromEntry(dk, entryId) {
  const e = state.data[dk] && state.data[dk][entryId];
  if (!e) return;
  const v = Number(e.value);
  setSliderToValue(v);
  updateFeel();
  if (Number.isFinite(e.ts)) {
    const t = new Date(e.ts);
    timeInput.value = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  } else {
    timeInput.value = "";
  }
  populateOrtOptions(((e.ort ?? e.situation) || "").trim());
  selectedBefinden.clear();
  for (const t of normalizeTags(e.befinden)) selectedBefinden.add(t);
  selectedBegleitung.clear();
  for (const t of normalizeTags(e.begleitung)) selectedBegleitung.add(t);
  befindenNewInput.hidden = true; befindenNewInput.value = "";
  begleitungNewInput.hidden = true; begleitungNewInput.value = "";
  populateBefindenChips();
  populateBegleitungChips();
  noteInput.value = (e.note || "").trim();
  updateNoteCount();
}

function populateFormDefaults(dk) {
  const isToday = dk === dayKey(new Date());
  const entries = state.data[dk] ? Object.entries(state.data[dk]).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0)) : [];
  const lastVal = entries.length ? Number(entries[entries.length - 1][1].value) : NaN;
  const seed = Number.isFinite(lastVal) ? lastVal : 50;
  setSliderToValue(seed);
  updateFeel();
  const now = new Date();
  /* Rückwirkende Tage: timeInput bleibt LEER, damit der User bewusst
     eine Uhrzeit eingibt (verhindert Verzerrung des Tageszeit-Histogramms
     durch unbewusste 12:00-Defaults). */
  if (isToday) {
    timeInput.value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  } else {
    timeInput.value = "";
  }
  populateOrtOptions("");
  selectedBefinden.clear();
  selectedBegleitung.clear();
  befindenNewInput.hidden = true; befindenNewInput.value = "";
  begleitungNewInput.hidden = true; begleitungNewInput.value = "";
  populateBefindenChips();
  populateBegleitungChips();
  noteInput.value = "";
  updateNoteCount();
}

/* Snapshot der aktuellen Form als Baseline für Dirty-Detection setzen. */
function captureInitialSnapshot() {
  sheetInitial = readFormSnapshot();
}

export function openSheet(dk, preselectEntryId = null) {
  if (!canWrite()) return;
  state.selectedDayKey = dk;
  state.editingEntryId = null;
  const d = parseDayKey(dk);
  const todayKey = dayKey(new Date());
  const isToday  = dk === todayKey;
  const isFuture = dk > todayKey; // YYYY-MM-DD lex-sortiert == chronologisch
  applySheetReadonly(isFuture);
  sheetTitle.textContent = isToday ? "Heutiger Check-in" : `Check-in · ${d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
  if (isFuture) {
    sheetSubtitle.textContent = "Dieser Tag liegt in der Zukunft. Du kannst hier nur ältere Einträge ansehen.";
  } else {
    sheetSubtitle.textContent = isToday ? "Wie fühlst du dich gerade?" : "Eintrag rückwirkend erfassen oder bearbeiten.";
  }

  /* Form befüllen: entweder mit Defaults (neuer Eintrag) oder mit
     einem konkreten Eintrag (Suche/Tap auf Listenzeile). */
  if (preselectEntryId && state.data[dk] && state.data[dk][preselectEntryId]) {
    state.editingEntryId = preselectEntryId;
    populateFormFromEntry(dk, preselectEntryId);
  } else {
    populateFormDefaults(dk);
  }

  renderEntryList(dk);
  updateModeBanner();
  captureInitialSnapshot();
  refreshDirtyIndicator();

  backdrop.classList.add("open");
  sheet.classList.add("open");
  document.body.classList.add("modal-open");
  /* Slider ist die zentrale Aktion → bekommt sofort Fokus für Tastatur-Bedienung. */
  requestAnimationFrame(() => { try { slider.focus(); } catch (_) {} });
}

/* Setzt das Sheet zurück in den „Neuer Eintrag"-Modus für den aktuell
   geöffneten Tag — wird vom „Neuen Eintrag anlegen"-Button getriggert,
   sowie nach einem Save als Aufräumarbeit, falls das Sheet offen bleibt. */
function resetSheetToNew() {
  const dk = state.selectedDayKey;
  if (!dk) return;
  state.editingEntryId = null;
  populateFormDefaults(dk);
  renderEntryList(dk);
  updateModeBanner();
  captureInitialSnapshot();
  refreshDirtyIndicator();
}

function closeSheet() {
  backdrop.classList.remove("open");
  sheet.classList.remove("open");
  document.body.classList.remove("modal-open");
  applySheetReadonly(false);
  state.selectedDayKey = null;
  state.editingEntryId = null;
  sheetInitial = null;
}

/* Vor jedem destruktiven UI-Wechsel (Schließen / Switch / Reset) prüfen,
   ob noch ungespeicherte Eingaben in der Form sind. Falls ja → Confirm
   einblenden; Cancel im Confirm bricht ab, Bestätigen ruft `proceed()`. */
function withDirtyGuard(proceed, opts = {}) {
  if (!isSheetDirty()) { proceed(); return; }
  openConfirm({
    title: opts.title || "Eingaben verwerfen?",
    bodyHtml: opts.body || "Du hast die Form geändert, aber noch nichts gespeichert. Wenn du jetzt fortfährst, gehen die Änderungen verloren.",
    confirmLabel: opts.confirmLabel || "Verwerfen",
    danger: true,
    onConfirm: proceed
  });
}

/* Sperrt/entsperrt alle Eingaben im Sheet — wird für Tage in der
   Zukunft aktiviert. Save-Button + Inputs werden disabled, Chips
   übernimmt die CSS-Regel `.sheet.is-readonly`. */
function applySheetReadonly(locked) {
  sheet.classList.toggle("is-readonly", !!locked);
  const lockables = [
    slider, ortSelect, ortInput,
    befindenNewInput, begleitungNewInput,
    noteInput, timeInput
  ];
  for (const el of lockables) { if (el) el.disabled = !!locked; }
  const nowBtnEl = document.getElementById("nowBtn");
  if (nowBtnEl) nowBtnEl.disabled = !!locked;
  const saveBtnEl = document.getElementById("saveBtn");
  if (saveBtnEl) saveBtnEl.disabled = !!locked;
  const hint = document.getElementById("readonlyHint");
  if (hint) hint.hidden = !locked;
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
    const befTags = normalizeTags(e.befinden);
    const beglTags = normalizeTags(e.begleitung);
    const note = (e.note || "").trim();
    const ortSafe = ort ? escapeHtml(ort) : "";
    const noteSafe = note ? escapeHtml(note) : "";
    const tagParts = [
      ortSafe,
      ...befTags.map(escapeHtml),
      ...beglTags.map(t => `mit ${escapeHtml(t)}`)
    ].filter(Boolean);
    const isActive = id === state.editingEntryId;
    const row = document.createElement("div");
    row.className = "entry" + (isActive ? " active" : "");
    row.style.setProperty("--active-color", c.hex);
    row.title = isActive
      ? "Du bearbeitest diesen Eintrag"
      : "Klicken, um diesen Eintrag zu bearbeiten";
    row.innerHTML = `
      <div class="dot" style="background:${c.hex}"></div>
      <div class="info">
        <div class="time">
          <span>${e.ts ? fmtTime(e.ts) : "—"} · ${valueToLabel(v)}</span>
          <span class="edit-badge">✏️ wird bearbeitet</span>
        </div>
        <div class="meta">Wert ${v}${tagParts.length ? ` · ${tagParts.join(" · ")}` : ""}</div>
        ${noteSafe ? `<div class="note-indicator" title="${noteSafe}">${noteSafe}</div>` : ""}
      </div>
      <button class="del" title="Eintrag löschen" aria-label="Eintrag löschen">✕</button>
    `;
    row.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("del")) return;
      if (id === state.editingEntryId) return; // schon aktiv
      const switchTo = () => {
        state.editingEntryId = id;
        populateFormFromEntry(dk, id);
        renderEntryList(dk);
        updateModeBanner();
        captureInitialSnapshot();
        refreshDirtyIndicator();
      };
      withDirtyGuard(switchTo, {
        title: "Anderen Eintrag öffnen?",
        body: "Du hast die aktuelle Form geändert, aber noch nicht gespeichert. Beim Öffnen eines anderen Eintrags gehen die Änderungen verloren.",
        confirmLabel: "Trotzdem öffnen"
      });
    });
    row.querySelector(".del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const entry = state.data[dk] && state.data[dk][id];
      if (!entry) return;
      openConfirm({
        title: "Eintrag wirklich löschen?",
        bodyHtml: "Dieser Check-in wird entfernt. Direkt danach kannst du das Löschen 5 Sekunden lang über den Toast widerrufen.",
        summaryNode: buildDeleteSummary(entry),
        confirmLabel: "Löschen",
        danger: true,
        onConfirm: () => requestDeleteWithUndo(dk, id)
      });
    });
    entryList.appendChild(row);
  }
}

function genTempId() {
  if (crypto && crypto.randomUUID) return "local-" + crypto.randomUUID();
  return "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

/* Tag-Felder beim Schreiben rückwärts­kompatibel halten:
   leer → null/weggelassen, 1 Tag → String (alte Reader können damit umgehen),
   ≥2 Tags → Array. */
function tagsToStored(arr) {
  if (!arr || !arr.length) return null;
  if (arr.length === 1) return arr[0];
  return arr.slice();
}

function saveEntry(dk, entryId, v, ts, ort, befinden, begleitung, note) {
  if (!canWrite()) return;
  // Defense-in-depth: niemals Check-ins für Tage in der Zukunft anlegen,
  // selbst wenn das Sheet-UI umgangen würde.
  if (dk > dayKey(new Date())) return;
  if (!state.data[dk]) state.data[dk] = {};
  const cleanNote = (note || "").trim();
  const befStored = tagsToStored(befinden);
  const beglStored = tagsToStored(begleitung);
  if (entryId) {
    const updatePayload = { value: v, ts };
    updatePayload.ort = ort || null;
    updatePayload.befinden = befStored;
    updatePayload.begleitung = beglStored;
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
    if (befStored != null) state.data[dk][entryId].befinden = befStored;
    else delete state.data[dk][entryId].befinden;
    if (beglStored != null) state.data[dk][entryId].begleitung = beglStored;
    else delete state.data[dk][entryId].begleitung;
    if (cleanNote) state.data[dk][entryId].note = cleanNote;
    else delete state.data[dk][entryId].note;

    if (entryId.startsWith("local-")) {
      // Pending push-Op patchen statt neue Op zu erzeugen
      const p = state.pendingQueue.find(q => q.op === "push" && q.tempId === entryId);
      if (p) {
        p.payload = { value: v, ts };
        if (ort) p.payload.ort = ort;
        if (befStored != null) p.payload.befinden = befStored;
        if (beglStored != null) p.payload.begleitung = beglStored;
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
    if (befStored != null) payload.befinden = befStored;
    if (beglStored != null) payload.begleitung = beglStored;
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
  befindenChips = document.getElementById("befindenChips");
  befindenNewInput = document.getElementById("befindenNewInput");
  begleitungChips = document.getElementById("begleitungChips");
  begleitungNewInput = document.getElementById("begleitungNewInput");
  sliderTicks = document.getElementById("sliderTicks");
  noteInput = document.getElementById("noteInput");
  noteCount = document.getElementById("noteCount");
  exportBtn = document.getElementById("exportBtn");
  saveBtn   = document.getElementById("saveBtn");
  cancelBtn = document.getElementById("cancelBtn");
  nowBtn    = document.getElementById("nowBtn");
  modeBanner       = document.getElementById("modeBanner");
  modeBannerIcon   = document.getElementById("modeBannerIcon");
  modeBannerTitle  = document.getElementById("modeBannerTitle");
  modeBannerSub    = document.getElementById("modeBannerSub");
  modeBannerDirty  = document.getElementById("modeBannerDirty");
  modeResetLink    = document.getElementById("modeResetLink");
  entryResetRow    = document.getElementById("entryResetRow");
  newEntryBtn      = document.getElementById("newEntryBtn");
  confirmOverlay   = document.getElementById("confirmOverlay");
  confirmTitleEl   = document.getElementById("confirmTitle");
  confirmBody      = document.getElementById("confirmBody");
  confirmNote      = document.getElementById("confirmNote");
  confirmCancel    = document.getElementById("confirmCancel");
  confirmOk        = document.getElementById("confirmOk");

  // Slider-Ticks einmalig erzeugen
  sliderTicks.innerHTML = SCALE.map(s => `<span>${s.tick}</span>`).join("");

  // Dirty-Indikator bei jeder Form-Änderung neu setzen.
  const wireDirtyChange = (el, evt) =>
    el && el.addEventListener(evt, refreshDirtyIndicator);
  slider.addEventListener("input", () => { updateFeel(); refreshDirtyIndicator(); });
  noteInput.addEventListener("input", () => { updateNoteCount(); refreshDirtyIndicator(); });
  wireDirtyChange(timeInput, "input");
  wireDirtyChange(ortSelect, "change");
  wireDirtyChange(ortInput, "input");
  wireDirtyChange(befindenNewInput, "input");
  wireDirtyChange(begleitungNewInput, "input");

  wireTagSelect(ortSelect, ortInput);
  wireNewInput(
    befindenNewInput, befindenChips,
    () => collectKnownTagValues("befinden"),
    selectedBefinden, "+ neu"
  );
  wireNewInput(
    begleitungNewInput, begleitungChips,
    () => collectKnownTagValues("begleitung"),
    selectedBegleitung, "+ neu"
  );

  // Tab-Falle + ESC im Sheet (Confirm hat eigene ESC-Behandlung)
  document.addEventListener("keydown", (ev) => {
    if (_confirmOpen) {
      if (ev.key === "Escape") { ev.preventDefault(); closeConfirm(false); return; }
      if (ev.key === "Enter" && document.activeElement === confirmOk) {
        // Enter auf dem OK-Button löst Confirm bewusst aus — ist Default.
      }
      if (ev.key !== "Tab") return;
      const items = Array.from(confirmOverlay.querySelectorAll(
        'button:not([disabled])'
      ));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      return;
    }
    if (!sheet.classList.contains("open")) return;
    if (ev.key === "Escape") { ev.preventDefault(); attemptCloseSheet(); return; }
    if (ev.key !== "Tab") return;
    const items = focusableInSheet();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });

  /* Schließt das Sheet — aber fragt erst nach, falls Form dirty ist. */
  function attemptCloseSheet() {
    withDirtyGuard(closeSheet);
  }

  backdrop.onclick = attemptCloseSheet;
  cancelBtn.onclick = attemptCloseSheet;
  nowBtn.onclick = () => {
    const n = new Date();
    timeInput.value = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
    refreshDirtyIndicator();
  };

  /* „Neuen Eintrag anlegen"-Button (sichtbar nur im Edit-Modus). */
  newEntryBtn.onclick = () => {
    withDirtyGuard(resetSheetToNew, {
      title: "Aktuelle Eingaben verwerfen?",
      body: "Du bearbeitest gerade einen Eintrag. Beim Anlegen eines neuen Eintrags gehen die ungespeicherten Änderungen verloren.",
      confirmLabel: "Neuen Eintrag anlegen"
    });
  };

  /* „↺ Original"-Link im Modus-Banner — setzt nur die Form auf die
     ursprünglichen Werte des bearbeiteten Eintrags zurück, OHNE den
     Edit-Modus zu verlassen. */
  modeResetLink.onclick = () => {
    const dk = state.selectedDayKey;
    const id = state.editingEntryId;
    if (!dk || !id || !state.data[dk] || !state.data[dk][id]) return;
    populateFormFromEntry(dk, id);
    refreshDirtyIndicator();
  };

  saveBtn.onclick = () => {
    if (!canWrite()) return;
    if (!state.selectedDayKey) return;
    const dk = state.selectedDayKey;
    const v = sliderValue();
    /* Form-Werte einsammeln (inkl. ungespeicherter "+ neu"-Tags). */
    const readTag = (selectEl, inputEl) =>
      selectEl.value === "__new__" ? (inputEl.value || "").trim() : (selectEl.value || "").trim();
    const ort = readTag(ortSelect, ortInput);
    const pendingBef = (befindenNewInput.value || "").trim();
    if (pendingBef) selectedBefinden.add(pendingBef);
    const pendingBegl = (begleitungNewInput.value || "").trim();
    if (pendingBegl) selectedBegleitung.add(pendingBegl);
    const befinden = Array.from(selectedBefinden);
    const begleitung = Array.from(selectedBegleitung);
    const note = (noteInput.value || "").trim();

    /* Zeit verarbeiten. Leeres Feld → Confirm warnt, dann Default 12:00. */
    const timeRaw = (timeInput.value || "").trim();
    const timeEmpty = !timeRaw;
    const [rawHh, rawMm] = (timeRaw || "12:00").split(":").map(Number);
    const hh = Number.isFinite(rawHh) ? Math.max(0, Math.min(23, rawHh)) : 12;
    const mm = Number.isFinite(rawMm) ? Math.max(0, Math.min(59, rawMm)) : 0;
    const d = parseDayKey(dk);
    d.setHours(hh, mm, 0, 0);
    const ts = d.getTime();
    const timeDisplay = `${pad(hh)}:${pad(mm)}`;

    const editingId = state.editingEntryId;
    const isEdit = !!editingId;
    const oldEntry = isEdit ? state.data[dk] && state.data[dk][editingId] : null;
    const dkLabel = parseDayKey(dk).toLocaleDateString("de-DE", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    });

    /* Bei „Bearbeiten" ohne tatsächliche Änderung: kurzer Toast statt Confirm. */
    if (isEdit && !isSheetDirty()) {
      showToast("Keine Änderungen — nichts zu speichern.", null, null, 2500);
      return;
    }

    const summary = buildSaveSummary({
      isEdit,
      oldEntry,
      newValues: {
        value: v, time: timeDisplay,
        ort, befinden, begleitung, note
      },
      dkLabel
    });

    const offlineHint = !state.serverConnected
      ? "Du bist offline — der Eintrag wird lokal gespeichert und automatisch synchronisiert, sobald die Verbindung wieder steht."
      : null;
    const timeWarnHint = timeEmpty
      ? "Du hast keine Uhrzeit angegeben. Der Eintrag wird mit 12:00 Uhr abgelegt."
      : null;
    const noteText = [timeWarnHint, offlineHint].filter(Boolean).join("  ·  ") || null;

    openConfirm({
      title: isEdit ? "Eintrag überschreiben?" : "Neuen Check-in speichern?",
      bodyHtml: isEdit
        ? "Die bisherigen Werte werden mit den neuen ersetzt. Du kannst danach jederzeit weiter bearbeiten."
        : "Bitte prüfe die Werte. Nach dem Speichern erscheint der Eintrag in der Liste dieses Tages.",
      summaryNode: summary,
      noteText,
      confirmLabel: isEdit ? "Änderungen speichern" : "Speichern",
      danger: isEdit,
      onConfirm: () => {
        saveEntry(dk, editingId, v, ts, ort, befinden, begleitung, note);
        closeSheet();
      }
    });
  };

  if (exportBtn) exportBtn.addEventListener("click", exportData);

  /* Confirm-Modal: Buttons + Backdrop-Klick. */
  confirmCancel.addEventListener("click", () => closeConfirm(false));
  confirmOk.addEventListener("click", () => closeConfirm(true));
  confirmOverlay.addEventListener("click", (ev) => {
    if (ev.target === confirmOverlay) closeConfirm(false);
  });

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

  /* Volltext-Suche (#40) */
  initSearch();

  /* Onboarding (#29) */
  initOnboarding();

  /* Besucher-Vorschau (nur für Admin sichtbar). */
  initPreviewToggle();

  // First paint des Slider-Feel-Anzeige (vor erstem Daten-Render).
  updateFeel();
}

/* ---------- Besucher-Vorschau (Admin-only Toggle) ----------
   Erlaubt dem Admin, die App so zu sehen wie ein Besucher-Account.
   Setzt visuell `body.viewer-mode` und `body.preview-mode` (Banner).
   Die echte Rolle (`state.currentRole`) bleibt unverändert — der Toggle
   ist eine reine UI-Vorschau. */
function initPreviewToggle() {
  const btn = document.getElementById("previewToggleBtn");
  const banner = document.getElementById("previewBanner");
  const exitBtn = document.getElementById("previewExitBtn");
  if (!btn || !banner || !exitBtn) return;

  const setPreview = (on) => {
    document.body.classList.toggle("viewer-mode", on);
    document.body.classList.toggle("preview-mode", on);
    banner.hidden = !on;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "🚪" : "👁";
    btn.title = on ? "Besucher-Vorschau verlassen" : "In Besucher-Vorschau umschalten";
    btn.setAttribute("aria-label", btn.title);
  };

  btn.addEventListener("click", () => {
    // Nur Admin darf die Vorschau aktivieren — Sicherheits-Check.
    if (state.currentRole !== "admin") return;
    const on = !document.body.classList.contains("preview-mode");
    setPreview(on);
  });

  exitBtn.addEventListener("click", () => setPreview(false));
}

/* ---------- Onboarding (#29) ---------- */
const ONBOARDING_LS_KEY = "tracker.onboarding.v1.seen";
const ONBOARDING_SLIDES = [
  {
    title: "So liest du die Skala",
    illu: `
      <div class="ob-scale" aria-hidden="true">
        <span class="pole left">♀</span>
        <span class="pole mid">⚧</span>
        <span class="pole right">♂</span>
      </div>`,
    body: `Nicht Schubladen, sondern ein <b>fließendes Spektrum</b> von 0 bis 100. Dein Wert kann jederzeit überall liegen — links, rechts, in der Mitte oder dazwischen. Die App misst keine "Wahrheit", sondern was du gerade <b>fühlst</b>.`
  },
  {
    title: "So checkst du ein",
    illu: `
      <div class="ob-mock" aria-hidden="true">
        <div class="ob-mock-row"><span class="num">1</span><span>Tippe das <b>+</b> unten rechts</span></div>
        <div class="ob-mock-row"><span class="num">2</span><span>Schiebe den <b>Slider</b> auf dein Gefühl</span></div>
        <div class="ob-mock-row"><span class="num">3</span><span>Optional: <b>Ort</b>, <b>Befinden</b>, <b>Begleitung</b>, <b>Notiz</b></span></div>
        <div class="ob-mock-row"><span class="num">4</span><span><b>Speichern</b> — fertig in 5 Sekunden</span></div>
      </div>`,
    body: `Lieber <b>mehrmals kurz</b> einchecken als einmal lang — so erfasst du auch Schwankungen im Tagesverlauf. Tippst du in der Einträge-Liste auf einen vorhandenen Eintrag, <b>bearbeitest</b> du ihn — du erstellst nicht automatisch einen neuen. Vor jedem Speichern und Löschen kommt eine Bestätigung mit Zusammenfassung.`
  },
  {
    title: "Was die Stats können — und was nicht",
    illu: `<div style="font-size:48px; line-height:1; margin-top:8px">📊</div>`,
    body: `Muster brauchen Daten. Verlass dich auf die Statistiken erst, wenn du mehrere Wochen erfasst hast. Bei wenigen Check-ins markieren wir die Werte als <b>wackelig</b>. Jede Karte hat ein <span class="ob-info-chip">ⓘ</span> — tippe darauf, um zu verstehen, was die jeweilige Auswertung wirklich misst.`
  }
];

let obIndex = 0;
let obOverlay, obSlide, obBack, obNext, obDots, obClose;
let _onboardingArmed = false;

function obRender() {
  const total = ONBOARDING_SLIDES.length;
  const slide = ONBOARDING_SLIDES[obIndex];
  obSlide.innerHTML = `
    <div class="ob-step">Schritt ${obIndex + 1} / ${total}</div>
    <h2 class="ob-title">${escapeHtml(slide.title)}</h2>
    <div class="ob-illu">${slide.illu}</div>
    <div class="ob-body">${slide.body}</div>
  `;
  obBack.disabled = obIndex === 0;
  obNext.textContent = obIndex === total - 1 ? "Verstanden" : "Weiter";
  obDots.innerHTML = ONBOARDING_SLIDES.map((_, i) =>
    `<span class="d${i === obIndex ? " active" : ""}"></span>`
  ).join("");
}

function obOpen(fromManual = false) {
  obIndex = 0;
  obOverlay.hidden = false;
  obRender();
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => obNext.focus());
  if (!fromManual) {
    // Auto-Open zählt sofort als "gesehen", damit es nicht beim nächsten
    // Refresh wieder erscheint.
    try { localStorage.setItem(ONBOARDING_LS_KEY, "1"); } catch {}
  }
}

function obCloseDialog() {
  obOverlay.hidden = true;
  document.body.style.overflow = "";
  try { localStorage.setItem(ONBOARDING_LS_KEY, "1"); } catch {}
}

function initOnboarding() {
  obOverlay = document.getElementById("onboardingOverlay");
  obSlide   = document.getElementById("onboardingSlide");
  obBack    = document.getElementById("onboardingBack");
  obNext    = document.getElementById("onboardingNext");
  obDots    = document.getElementById("onboardingDots");
  obClose   = document.getElementById("onboardingClose");
  const helpBtn = document.getElementById("helpBtn");
  if (!obOverlay || !obSlide) return;

  obBack.addEventListener("click", () => {
    if (obIndex > 0) { obIndex--; obRender(); }
  });
  obNext.addEventListener("click", () => {
    if (obIndex < ONBOARDING_SLIDES.length - 1) { obIndex++; obRender(); }
    else { obCloseDialog(); }
  });
  obClose.addEventListener("click", obCloseDialog);
  if (helpBtn) helpBtn.addEventListener("click", () => obOpen(true));

  document.addEventListener("keydown", (ev) => {
    if (obOverlay.hidden) return;
    if (ev.key === "Escape") { ev.preventDefault(); obCloseDialog(); }
    else if (ev.key === "ArrowRight") { obNext.click(); }
    else if (ev.key === "ArrowLeft")  { obBack.click(); }
  });
  _onboardingArmed = true;
}

/* Wird aus auth.js gerufen, sobald der User eingeloggt und das
   Login-Gate weg ist. Zeigt das Onboarding einmalig (Flag in
   localStorage). */
export function maybeShowOnboarding() {
  if (!_onboardingArmed) return;
  try {
    if (localStorage.getItem(ONBOARDING_LS_KEY) === "1") return;
  } catch { return; }
  // Kleiner Delay, damit die App "ankommt", bevor wir overlay aufmachen.
  setTimeout(() => {
    if (!obOverlay.hidden) return;
    obOpen(false);
  }, 600);
}

/* ---------- Volltext-Suche (#40) ---------- */
function initSearch() {
  const btn = document.getElementById("searchBtn");
  const panel = document.getElementById("searchPanel");
  const input = document.getElementById("searchInput");
  const closeBtn = document.getElementById("searchClose");
  const results = document.getElementById("searchResults");
  if (!btn || !panel || !input || !closeBtn || !results) return;

  const open = () => {
    panel.hidden = false;
    requestAnimationFrame(() => input.focus());
    renderSearchResults(input.value, results);
  };
  const close = () => {
    panel.hidden = true;
    input.value = "";
    results.replaceChildren();
  };

  btn.addEventListener("click", () => {
    if (panel.hidden) open(); else close();
  });
  closeBtn.addEventListener("click", close);

  input.addEventListener("input", () => renderSearchResults(input.value, results));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
  });

  results.addEventListener("click", (ev) => {
    const row = ev.target.closest("[data-dk]");
    if (!row) return;
    const dk = row.dataset.dk;
    const eid = row.dataset.eid;
    close();
    openSheet(dk, eid);
  });
}

const SEARCH_MAX_RESULTS = 50;
function renderSearchResults(query, container) {
  const q = (query || "").trim().toLowerCase();
  container.replaceChildren();
  if (!q) return;
  const matches = [];
  for (const dk in state.data) {
    for (const id in state.data[dk]) {
      const e = state.data[dk][id];
      const ort = (e.ort ?? e.situation ?? "").trim();
      const befTags = normalizeTags(e.befinden);
      const beglTags = normalizeTags(e.begleitung);
      const note = (e.note || "").trim();
      const haystack = [
        note, ort,
        ...befTags,
        ...beglTags
      ].join("\n").toLowerCase();
      if (!haystack.includes(q)) continue;
      matches.push({ dk, id, e, ort, befTags, beglTags, note });
    }
  }
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = `Keine Treffer für „${query}".`;
    container.appendChild(empty);
    return;
  }
  // Chronologisch absteigend (neueste zuerst)
  matches.sort((a, b) => (b.e.ts || 0) - (a.e.ts || 0));
  const shown = matches.slice(0, SEARCH_MAX_RESULTS);
  for (const m of shown) {
    const v = Number(m.e.value);
    const c = valueToColor(v);
    const d = parseDayKey(m.dk);
    const dateLabel = d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const time = m.e.ts ? fmtTime(m.e.ts) : "—";
    const tagParts = [
      m.ort,
      ...m.befTags,
      ...m.beglTags.map(t => `mit ${t}`)
    ].filter(Boolean).map(escapeHtml).join(" · ");
    const snippet = m.note ? highlightSnippet(m.note, q) : "";
    const row = document.createElement("div");
    row.className = "search-row";
    row.dataset.dk = m.dk;
    row.dataset.eid = m.id;
    row.setAttribute("role", "option");
    row.tabIndex = 0;
    row.innerHTML = `
      <div class="search-row-head">
        <span class="dot" style="background:${c.hex}"></span>
        <span>${escapeHtml(dateLabel)} · ${time}</span>
        <span class="val">Wert ${v}</span>
      </div>
      ${tagParts ? `<div class="search-row-tags">${tagParts}</div>` : ""}
      ${snippet ? `<div class="search-row-snip">${snippet}</div>` : ""}
    `;
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    container.appendChild(row);
  }
  if (matches.length > SEARCH_MAX_RESULTS) {
    const more = document.createElement("div");
    more.className = "search-empty";
    more.textContent = `… ${matches.length - SEARCH_MAX_RESULTS} weitere Treffer. Suche präzisieren, um sie zu sehen.`;
    container.appendChild(more);
  }
}

function highlightSnippet(text, q) {
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return escapeHtml(text);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + q.length + 60);
  const prefix = start > 0 ? "… " : "";
  const suffix = end < text.length ? " …" : "";
  const before = escapeHtml(text.slice(start, idx));
  const match = escapeHtml(text.slice(idx, idx + q.length));
  const after = escapeHtml(text.slice(idx + q.length, end));
  return prefix + before + "<mark>" + match + "</mark>" + after + suffix;
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
  /* Native <details>/<summary>-Toggle übernehmen lassen. preventDefault auf
     click ist race-anfällig (insb. iOS Safari schaltet vor dem Listener
     nativ um → wasOpen liest falsch → öffnet sofort wieder). Stattdessen:
     - 'toggle' (capture, da nicht-bubbling) erzwingt "nur eine offen"
     - Document-click schließt bei Klick außerhalb
     - ESC schließt alle */
  const closeAll = (except = null) => {
    for (const d of document.querySelectorAll("details.info[open]")) {
      if (d !== except) d.removeAttribute("open");
    }
  };
  document.addEventListener("toggle", (ev) => {
    const d = ev.target;
    if (!(d instanceof HTMLDetailsElement)) return;
    if (!d.classList.contains("info")) return;
    if (d.open) closeAll(d);
  }, true);
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
  populateOrtOptions(keepOrt);
  // Sets bleiben erhalten; nur das Pool bekannter Tags neu einsammeln.
  populateBefindenChips();
  populateBegleitungChips();
  if (state.selectedDayKey) renderEntryList(state.selectedDayKey);
  updateModeBanner();
  refreshDirtyIndicator();
}
