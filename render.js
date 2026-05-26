/* Render-Schicht: pure DOM-Erzeugung aus state.data + abgeleiteten Stats.
   Selbst keine Mutation am State — abonniert state.notify und re-rendert. */

import { state, subscribe, setStatsRange } from "./state.js";
import {
  dayKey, parseDayKey,
  avg, stddev, median, percentile, bucket,
  computeStats, computeCoverage, computePeriodAggregates, computeFluidityIndex,
  computeBuckets, computeWeekdayMedians,
  filterDataByRange, computeTransitions,
  detectFirstSeenTag, detectFirstSeenCombo, detectDecliningTag, detectRangeShrinking
} from "./stats.js";
import {
  SCALE, scaleIndexFromValue,
  valueToColor, contrastText, valueToSymbol, valueToHeroSymbol, valueToLabel,
  setText, escapeHtml
} from "./format.js";
import { openSheet, syncSheetAfterRender } from "./ui.js";

const RANGE_LABELS = {
  "7d": "letzte 7 Tage",
  "30d": "letzte 30 Tage",
  "90d": "letzte 90 Tage",
  "1y":  "letztes Jahr",
  "all": "alle Daten"
};

const MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];

function dayAverage(dk) {
  const entries = state.data[dk];
  if (!entries) return null;
  const vals = Object.values(entries).map(e => Number(e.value)).filter(v => !isNaN(v));
  return vals.length ? avg(vals) : null;
}
function dayCount(dk) {
  return state.data[dk] ? Object.keys(state.data[dk]).length : 0;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  const monthTitle = document.getElementById("monthTitle");
  grid.innerHTML = "";
  const y = state.viewDate.getFullYear(), m = state.viewDate.getMonth();
  monthTitle.textContent = `${MONTH_NAMES[m]} ${y}`;
  const first = new Date(y, m, 1);
  const last  = new Date(y, m + 1, 0);
  let offset = (first.getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) {
    const c = document.createElement("div");
    c.className = "cell empty";
    grid.appendChild(c);
  }
  const todayKey = dayKey(new Date());
  for (let d = 1; d <= last.getDate(); d++) {
    const dt = new Date(y, m, d);
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
          <div class="spectrum-range" style="left:${rangeLeft}%; right:${100 - rangeRight}%;"></div>
          <div class="spectrum-marker is-small" style="left:${Math.max(0, Math.min(100, minV))}%; background:${cMin.hex}; border-color:${cMin.hex};"></div>
          <div class="spectrum-marker is-small" style="left:${Math.max(0, Math.min(100, maxV))}%; background:${cMax.hex}; border-color:${cMax.hex};"></div>
          <div class="spectrum-marker" style="left:${Math.max(0, Math.min(100, medV))}%; background:${cMed.hex}; border-color:${cMed.hex};"></div>
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
      <div class="sub">${sub || ""}</div>
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
  const todayDk = dayKey(new Date());
  const todayCount = state.data[todayDk] ? Object.keys(state.data[todayDk]).length : 0;
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
      <button class="btn-checkin" id="heroCheckinBtn" type="button">+ Weiterer Check-in</button>
      <div class="hero-count-hint">${todayCount} Eintrag${todayCount === 1 ? "" : "e"} heute · jeder Tap legt einen neuen an</div>
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
    return `<div class="sbar" style="height:${h}%; background:${c.hex};" title="${SCALE[i].label}: ${n} Tag${n === 1 ? "" : "e"}"></div>`;
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
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const v = stats.dayAvgs[dayKey(d)];
    pts.push({ i: days - 1 - i, v });
  }
  const w = 300, h = 80, pad = 4;
  const xStep = (w - pad * 2) / (days - 1);
  let path = "";
  let last = null;
  pts.forEach((p, idx) => {
    if (p.v == null) { last = null; return; }
    const x = pad + idx * xStep;
    const y = pad + (1 - p.v / 100) * (h - pad * 2);
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
    const x = pad + idx * xStep;
    const y = pad + (1 - ema / 100) * (h - pad * 2);
    emaPath += (emaLast === null ? `M ${x} ${y}` : ` L ${x} ${y}`);
    emaLast = { x, y };
  });
  const dots = pts.map((p, idx) => {
    if (p.v == null) return "";
    const c = valueToColor(p.v);
    const x = pad + idx * xStep;
    const y = pad + (1 - p.v / 100) * (h - pad * 2);
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
    <line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="2 3"/>
    <path d="${path}" fill="none" stroke="url(#sg)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>
    <path d="${emaPath}" fill="none" stroke="url(#sg)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  `;
}

function renderHeatmap(stats) {
  const hm = document.getElementById("heatmap");
  hm.innerHTML = "";
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const todayK = dayKey(end);
  /* Robuster Startpunkt: exakt 365 Tage zurück (statt setMonth(-12), das
     an Monatskanten wie 31. März in nicht-existente Daten kippt) und auf
     Mitternacht normiert (DST-Schutz). */
  const start = new Date(end); start.setDate(start.getDate() - 365);
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  /* Kalender-Iteration statt Math.ceil(ms-Diff/86400000): DST-Tage haben
     23/25 h und brechen die ms-Schätzung. Wir zählen Tage real ab. */
  const cells = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    cells.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  while (cells.length % 7 !== 0) {
    const next = new Date(cells[cells.length - 1]);
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
    bar.style.height = (c / max * 100) + "%";
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
      <div class="v" style="${c ? `color:${c.hex}` : ''}">${day.median != null ? day.median.toFixed(1) : "—"}</div>
      <div class="sw" style="background:${c ? c.hex : 'rgba(255,255,255,0.06)'}"></div>
      <div class="wd-n" title="${day.n} Tag${day.n === 1 ? "" : "e"} erfasst">n=${day.n}</div>
    `;
    row.appendChild(div);
  }
}

function renderStreaks(stats) {
  const keys = stats.dayKeys;
  let longestF = 0, longestM = 0, longestFL = 0;
  let curF = 0, curM = 0, curFL = 0;
  const ordered = keys.map(k => ({ k, v: stats.dayAvgs[k], b: bucket(stats.dayAvgs[k]) }));
  let prev = null;
  for (const o of ordered) {
    const d = parseDayKey(o.k);
    // Math.round schützt gegen DST-Drift (Sommerzeitumstellung ±1 h)
    const consecutive = prev && Math.round((d - prev) / (1000 * 60 * 60 * 24)) === 1;
    if (!consecutive) { curF = curM = curFL = 0; }
    if (o.b === "f") { curF++; curM = 0; curFL = 0; }
    else if (o.b === "m") { curM++; curF = 0; curFL = 0; }
    else { curFL++; curF = 0; curM = 0; }
    longestF = Math.max(longestF, curF);
    longestM = Math.max(longestM, curM);
    longestFL = Math.max(longestFL, curFL);
    prev = d;
  }
  const vols = Object.values(stats.dayAvgs);
  const vol = stddev(vols);
  /* Min / Max — bevorzugt Tage mit mindestens 2 Einträgen. */
  let minDay = null, maxDay = null;
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
  const today = new Date();
  const pts = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const v = stats.dayAvgs[dayKey(d)];
    if (v != null) pts.push({ x: 29 - i, y: v });
  }
  let slope = 0;
  if (pts.length >= 2) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n;
    const my = pts.reduce((s, p) => s + p.y, 0) / n;
    let num = 0, den = 0;
    for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) * (p.x - mx); }
    slope = den ? num / den : 0;
  }
  const parts = { Morgen: 0, Mittag: 0, Abend: 0, Nacht: 0 };
  for (const e of stats.allEntries) {
    if (!e.ts) continue;
    const h = new Date(e.ts).getHours();
    if (h < 6) parts.Nacht++;
    else if (h < 12) parts.Morgen++;
    else if (h < 18) parts.Mittag++;
    else parts.Abend++;
  }
  let topPart = "—", topPartCnt = 0;
  for (const k in parts) if (parts[k] > topPartCnt) { topPart = k; topPartCnt = parts[k]; }

  function cell(label, value, sub, color) {
    return `<div class="stat">
      <div class="label">${label}</div>
      <div class="value" style="${color ? `color:${color}` : ''}">${value}</div>
      <div class="sub">${sub || ""}</div>
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
    return `${fmtDay(dk)} · ${n} Check-in${n === 1 ? "" : "s"}`;
  };
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

/* Korrelations-Matrix Ort × Befinden. */
function renderComboMatrix(stats) {
  const container = document.getElementById("comboMatrix");
  if (!container) return;
  const combos = Object.values(stats.byCombo);
  if (combos.length === 0) {
    container.innerHTML = `<div class="sit-empty">Erfasse Ort UND Befinden im selben Check-in, um Muster zwischen beiden sichtbar zu machen.</div>`;
    return;
  }
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
  const orteShown = orte.slice(0, 12);
  const befShown = befinden.slice(0, 12);
  const lookup = (o, b) => stats.byCombo[o + "␟" + b];

  let html = `<div class="combo-grid" style="grid-template-columns: minmax(80px, 1.4fr) repeat(${orteShown.length}, minmax(48px, 1fr));">`;
  html += `<div class="combo-corner"></div>`;
  for (const o of orteShown) {
    html += `<div class="combo-col-head" title="${escapeHtml(o)}">${escapeHtml(o)}</div>`;
  }
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
    html += `<div class="combo-note">Zeigt die häufigsten 12×12. Weitere Tags ausgeblendet: ${hiddenOrte} Ort${hiddenOrte === 1 ? "" : "e"}, ${hiddenBef} Befinden.</div>`;
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

  // 2) Wochenende vs. Werktag
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

  // 3) Tageszeit-Tendenz
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

  // 5) Aktuelle laufende Bucket-Serie
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

  // 6) Konsistenteste Werte pro Tag-Dimension
  const consistentTag = (byTag, tagKey, phrase) => {
    const matches = (e, name) => {
      const v = e[tagKey];
      if (Array.isArray(v)) return v.includes(name);
      return v === name;
    };
    const withSigma = Object.entries(byTag)
      .filter(([, agg]) => agg.count >= 5)
      .map(([name, agg]) => {
        const vals = stats.allEntries.filter(e => matches(e, name)).map(e => e.value);
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

  // 7) Schwankungs-Woche
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

  // 9) Neuer Ort / neues Befinden (#17): erstmals in den letzten 14 Tagen
  const recentOrte = detectFirstSeenTag(stats, "ort", 14);
  for (const t of recentOrte.slice(0, 1)) {
    out.push({
      weight: 58,
      color: valueToColor(t.avg != null ? t.avg : 50).hex,
      text: `Neu im Sprachgebrauch: <b>${escapeHtml(t.name)}</b> (${t.count} Check-in${t.count === 1 ? "" : "s"}${t.avg != null ? ", ⌀ " + t.avg.toFixed(0) : ""}).`
    });
  }
  const recentBef = detectFirstSeenTag(stats, "befinden", 14);
  for (const t of recentBef.slice(0, 1)) {
    out.push({
      weight: 56,
      color: valueToColor(t.avg != null ? t.avg : 50).hex,
      text: `Erstmals als Befinden: <b>${escapeHtml(t.name)}</b> (${t.count} Check-in${t.count === 1 ? "" : "s"}).`
    });
  }

  // 10) Neue Ort×Befinden-Kombo (#17)
  const recentCombos = detectFirstSeenCombo(stats, 14);
  for (const c of recentCombos.slice(0, 1)) {
    if (c.count >= 2) {
      out.push({
        weight: 54,
        color: "#c79bd0",
        text: `Erstmals: <b>${escapeHtml(c.ort)} · ${escapeHtml(c.befinden)}</b> (n=${c.count}).`
      });
    }
  }

  // 11) Seltener werdendes Befinden (#17)
  const declining = detectDecliningTag(stats, "befinden", 30, 5);
  for (const d of declining.slice(0, 1)) {
    out.push({
      weight: 52,
      color: "#ffb86b",
      text: `Du taggst <b>${escapeHtml(d.name)}</b> seit einem Monat deutlich seltener (${d.prior} → ${d.recent}, −${Math.round(d.drop * 100)} %).`
    });
  }

  // 12) Wert-Range schrumpft (#17)
  const shrink = detectRangeShrinking(stats, 14, 7);
  if (shrink.found) {
    out.push({
      weight: 53,
      color: "#9b8fb5",
      text: `Deine Werte sind in den letzten 2 Wochen <b>stabiler</b> geworden (σ ${shrink.sdRecent.toFixed(0)} statt ${shrink.sdPrior.toFixed(0)} davor).`
    });
  }

  // 8) All-Time-Rekord innerhalb der letzten 14 Tage
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
    // Floor + leichtes DST-Padding.
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

/* ---------- Zeitfenster-Toggle (#8) ---------- */
function renderRangeBar(stats) {
  const seg = document.getElementById("rangeSeg");
  const info = document.getElementById("rangeInfo");
  if (!seg) return;
  // Aktiver Knopf
  for (const btn of seg.querySelectorAll("button")) {
    const isActive = btn.dataset.range === state.statsRange;
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  }
  if (info) {
    const days = stats.dayKeys.length;
    const lbl = RANGE_LABELS[state.statsRange] || "alle Daten";
    info.textContent = days > 0
      ? `${lbl} · ${days} Tag${days === 1 ? "" : "e"} mit Check-ins`
      : `${lbl} · keine Daten`;
  }
}

/* ---------- Bucket-Übergangs-Matrix (#11) ---------- */
function renderTransitions(stats) {
  const container = document.getElementById("transitions");
  if (!container) return;
  const t = computeTransitions(stats);
  if (t.total === 0) {
    container.innerHTML = `<div class="transitions-empty">Übergänge erscheinen, sobald du mehrere Tage <b>direkt hintereinander</b> erfasst hast.</div>`;
    return;
  }
  const labels = [
    { key: "f", sym: "♀", word: "weiblich", color: valueToColor(17).hex },
    { key: "n", sym: "⚧", word: "fluid",    color: valueToColor(50).hex },
    { key: "m", sym: "♂", word: "männlich", color: valueToColor(83).hex }
  ];
  let html = `<div class="trans-corner"></div>`;
  for (const c of labels) {
    html += `<div class="trans-col-head" title="am Folgetag ${c.word}"><span style="color:${c.color}">${c.sym}</span><span class="arrow">→</span></div>`;
  }
  for (let r = 0; r < 3; r++) {
    const rl = labels[r];
    html += `<div class="trans-row-head" title="am Tag ${rl.word}"><span style="color:${rl.color}">${rl.sym}</span><span class="arrow">↓</span></div>`;
    for (let c = 0; c < 3; c++) {
      const n = t.counts[r][c];
      const p = t.probs[r][c];
      const isDiag = r === c;
      if (p == null || t.rowTotals[r] === 0) {
        html += `<div class="trans-cell is-empty${isDiag ? " is-diagonal" : ""}"><span class="pct">—</span><span class="n">keine Daten</span></div>`;
        continue;
      }
      const pct = Math.round(p * 100);
      // Hintergrund-Tönung: stärkste Zellen pro Zeile bekommen mehr Sättigung.
      const targetColor = labels[c].color;
      const intensity = Math.max(0.10, Math.min(0.95, p));
      const bg = hexToRgba(targetColor, intensity * 0.55 + 0.04);
      const txt = intensity > 0.55 ? "#1a0f29" : "var(--text)";
      html += `<div class="trans-cell${isDiag ? " is-diagonal" : ""}"
                 style="background:${bg};color:${txt}"
                 title="${rl.word} → ${labels[c].word}: ${pct}% (${n} von ${t.rowTotals[r]} Übergängen)">
        <span class="pct">${pct}%</span>
        <span class="n">n=${n}</span>
      </div>`;
    }
  }
  container.innerHTML = html;
}

function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
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

export function renderAll() {
  renderGrid();
  /* Stats werden zweifach berechnet: einmal mit allen Daten (für Karten,
     die ihren eigenen Sinn haben — Heatmap, Hero, Sparkline, Insights),
     einmal mit dem aktiven Zeitfenster (für alle anderen Karten). */
  const fullStats = computeStats(state.data);
  const stats = state.statsRange === "all"
    ? fullStats
    : computeStats(filterDataByRange(state.data, state.statsRange));

  applyMoodBackground(fullStats);
  renderRangeBar(stats);
  renderHeroToday(fullStats);
  renderOverviewBars(stats);
  renderOverviewMeta(stats);
  renderFluidityIndex(stats);
  renderSpectrumHistogram(stats);
  renderBuckets(stats);
  renderSparkline(fullStats);
  renderHeatmap(fullStats);
  renderHistogram(stats);
  renderWeekdays(stats);
  renderTagStats("ortStats", stats.byOrt, "Noch keine Orte erfasst — füge im Check-in einen hinzu.");
  renderTagStats("befindenStats", stats.byBefinden, "Noch kein Befinden erfasst — füge im Check-in eins hinzu.");
  renderTagStats("begleitungStats", stats.byBegleitung, "Noch keine Begleitung erfasst — füge im Check-in jemanden hinzu.");
  renderComboMatrix(stats);
  renderTransitions(stats);
  renderInsights(fullStats);
  renderStreaks(stats);
  syncSheetAfterRender();
}

function wireRangeBar() {
  const seg = document.getElementById("rangeSeg");
  if (!seg) return;
  seg.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-range]");
    if (!btn) return;
    const r = btn.dataset.range;
    if (r === state.statsRange) return;
    setStatsRange(r);
    renderAll();
  });
  // Tastatur: Pfeiltasten innerhalb der Gruppe
  seg.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const btns = Array.from(seg.querySelectorAll("button[data-range]"));
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const next = ev.key === "ArrowRight"
      ? btns[(i + 1) % btns.length]
      : btns[(i - 1 + btns.length) % btns.length];
    next.focus();
    next.click();
    ev.preventDefault();
  });
}

/* ---------- Rückblick (#9) ---------- */
const MONTH_NAMES_SHORT = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];

function fmtDateShort(d) {
  return `${d.getDate()}. ${MONTH_NAMES_SHORT[d.getMonth()]}`;
}
function fmtDayKeyShort(dk) {
  const d = parseDayKey(dk);
  return `${d.getDate()}. ${MONTH_NAMES_SHORT[d.getMonth()]}`;
}

function donutSvg(pctF, pctN, pctM) {
  const r = 70, C = 2 * Math.PI * r;
  const lenF = (C * pctF) / 100;
  const lenN = (C * pctN) / 100;
  const lenM = (C * pctM) / 100;
  const segs = [
    { len: lenF, off: 0, color: "var(--pink)" },
    { len: lenN, off: -lenF, color: "var(--neutral)" },
    { len: lenM, off: -(lenF + lenN), color: "var(--blue)" }
  ];
  const circles = segs
    .filter(s => s.len > 0.01)
    .map(s => `<circle cx="90" cy="90" r="${r}" fill="none" stroke="${s.color}" stroke-width="22"
                  stroke-dasharray="${s.len.toFixed(2)} ${(C - s.len).toFixed(2)}"
                  stroke-dashoffset="${s.off.toFixed(2)}"
                  transform="rotate(-90 90 90)"/>`)
    .join("");
  return `<svg class="donut" viewBox="0 0 180 180" aria-hidden="true">
    <circle cx="90" cy="90" r="${r}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="22"/>
    ${circles}
  </svg>`;
}

function buildReviewCards(period, now = new Date()) {
  const range = period === "week" ? "7d" : "30d";
  const days = period === "week" ? 7 : 30;
  const data = filterDataByRange(state.data, range, now);
  const stats = computeStats(data);
  const cards = [];

  /* Cover */
  const startD = new Date(now); startD.setHours(0, 0, 0, 0); startD.setDate(startD.getDate() - (days - 1));
  const endD = new Date(now); endD.setHours(0, 0, 0, 0);
  const totalEntries = stats.allEntries.length;
  const trackedDays = stats.dayKeys.length;
  const periodLabel = period === "week" ? "Diese Woche" : "Dieser Monat";
  const allAvg = avg(Object.values(stats.dayAvgs));
  const heroCol = allAvg != null ? valueToColor(allAvg) : { hex: "#c79bd0" };
  const heroSym = allAvg != null ? valueToHeroSymbol(allAvg) : "⚧";
  cards.push(`
    <div class="review-card">
      <div>
        <div class="eyebrow">Rückblick</div>
        <div class="headline">${periodLabel}</div>
        <div class="sub">${fmtDateShort(startD)} – ${fmtDateShort(endD)} ${endD.getFullYear()}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:84px; line-height:1; color:${heroCol.hex}; text-shadow: 0 0 28px ${heroCol.hex}">${heroSym}</div>
      </div>
      <div>
        <div class="number">${totalEntries}</div>
        <div class="sub">Check-ins an ${trackedDays} Tag${trackedDays === 1 ? "" : "en"}</div>
      </div>
    </div>
  `);

  if (totalEntries === 0) {
    cards.push(`
      <div class="review-card">
        <div class="review-empty">Noch keine Check-ins in diesem Zeitraum. Zeit, einen einzutragen!</div>
      </div>
    `);
    return cards;
  }

  /* Verteilung-Donut */
  const buckets = computeBuckets(stats);
  let headline = "gemischt";
  const top = Math.max(buckets.pctF, buckets.pctN, buckets.pctM);
  if (top === buckets.pctF && buckets.pctF >= 50) headline = "überwiegend weiblich";
  else if (top === buckets.pctM && buckets.pctM >= 50) headline = "überwiegend männlich";
  else if (top === buckets.pctN && buckets.pctN >= 50) headline = "überwiegend fluid";
  else if (buckets.pctF + buckets.pctM > buckets.pctN) headline = "bipolar verteilt";
  cards.push(`
    <div class="review-card">
      <div>
        <div class="eyebrow">Verteilung</div>
        <div class="headline">${headline}</div>
      </div>
      ${donutSvg(buckets.pctF, buckets.pctN, buckets.pctM)}
      <div class="legend">
        <span><span class="dot" style="background:var(--pink)"></span>weiblich · ${Math.round(buckets.pctF)}%</span>
        <span><span class="dot" style="background:var(--neutral)"></span>fluid · ${Math.round(buckets.pctN)}%</span>
        <span><span class="dot" style="background:var(--blue)"></span>männlich · ${Math.round(buckets.pctM)}%</span>
      </div>
    </div>
  `);

  /* Höchster / niedrigster Tag */
  let minDk = null, maxDk = null;
  for (const dk in stats.dayAvgs) {
    if (minDk === null || stats.dayAvgs[dk] < stats.dayAvgs[minDk]) minDk = dk;
    if (maxDk === null || stats.dayAvgs[dk] > stats.dayAvgs[maxDk]) maxDk = dk;
  }
  if (minDk && maxDk && minDk !== maxDk) {
    const cMin = valueToColor(stats.dayAvgs[minDk]);
    const cMax = valueToColor(stats.dayAvgs[maxDk]);
    cards.push(`
      <div class="review-card">
        <div>
          <div class="eyebrow">Tag-Extreme</div>
          <div class="headline">Deine Pole</div>
        </div>
        <div class="extreme">
          <div class="swatch" style="background:${cMin.hex}"></div>
          <div class="col">
            <div class="lbl">Tiefster Tag</div>
            <div class="val" style="color:${cMin.hex}">${stats.dayAvgs[minDk].toFixed(0)}</div>
            <div class="day">${escapeHtml(fmtDayKeyShort(minDk))} · ${escapeHtml(valueToLabel(stats.dayAvgs[minDk]))}</div>
          </div>
        </div>
        <div class="extreme">
          <div class="swatch" style="background:${cMax.hex}"></div>
          <div class="col">
            <div class="lbl">Höchster Tag</div>
            <div class="val" style="color:${cMax.hex}">${stats.dayAvgs[maxDk].toFixed(0)}</div>
            <div class="day">${escapeHtml(fmtDayKeyShort(maxDk))} · ${escapeHtml(valueToLabel(stats.dayAvgs[maxDk]))}</div>
          </div>
        </div>
      </div>
    `);
  }

  /* Häufigster Ort + Befinden */
  const topTag = (byTag) => {
    let best = null;
    for (const name in byTag) {
      const a = byTag[name];
      if (!best || a.count > best.count) best = { name, count: a.count, avg: a.sum / a.count };
    }
    return best;
  };
  const topOrt = topTag(stats.byOrt);
  const topBef = topTag(stats.byBefinden);
  if (topOrt || topBef) {
    cards.push(`
      <div class="review-card">
        <div>
          <div class="eyebrow">Häufig dabei</div>
          <div class="headline">Wo &amp; wie</div>
        </div>
        ${topOrt ? `
          <div class="extreme">
            <div class="swatch" style="background:${valueToColor(topOrt.avg).hex}"></div>
            <div class="col">
              <div class="lbl">Top-Ort</div>
              <div class="val">${escapeHtml(topOrt.name)}</div>
              <div class="day">${topOrt.count}× · ⌀ ${topOrt.avg.toFixed(0)}</div>
            </div>
          </div>` : ""}
        ${topBef ? `
          <div class="extreme">
            <div class="swatch" style="background:${valueToColor(topBef.avg).hex}"></div>
            <div class="col">
              <div class="lbl">Top-Befinden</div>
              <div class="val">${escapeHtml(topBef.name)}</div>
              <div class="day">${topBef.count}× · ⌀ ${topBef.avg.toFixed(0)}</div>
            </div>
          </div>` : ""}
      </div>
    `);
  }

  /* Vergleich zur Vorperiode */
  const priorEnd = new Date(startD); priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate() - (days - 1));
  const priorData = {};
  for (const dk in state.data) {
    const d = parseDayKey(dk);
    if (d >= priorStart && d <= priorEnd) priorData[dk] = state.data[dk];
  }
  const priorStats = computeStats(priorData);
  const priorAvgs = Object.values(priorStats.dayAvgs);
  if (allAvg != null && priorAvgs.length >= 1) {
    const priorAvg = avg(priorAvgs);
    const diff = allAvg - priorAvg;
    const arrow = Math.abs(diff) < 2 ? "→" : (diff > 0 ? "↗" : "↘");
    const dir = Math.abs(diff) < 2 ? "praktisch unverändert" : (diff > 0 ? "männlicher" : "weiblicher");
    const dCol = valueToColor(allAvg).hex;
    cards.push(`
      <div class="review-card">
        <div>
          <div class="eyebrow">Vergleich</div>
          <div class="headline">vs. ${period === "week" ? "Vorwoche" : "Vormonat"}</div>
        </div>
        <div style="text-align:center">
          <div class="number" style="color:${dCol}">${arrow} ${Math.abs(diff).toFixed(1)}</div>
          <div class="sub">Punkte ${dir}</div>
        </div>
        <div class="sub" style="text-align:center">
          ${period === "week" ? "Diese" : "Dieser"} ${period === "week" ? "Woche" : "Monat"}: ⌀ ${allAvg.toFixed(1)}<br>
          Vor${period === "week" ? "woche" : "monat"}: ⌀ ${priorAvg.toFixed(1)} (${priorAvgs.length} Tag${priorAvgs.length === 1 ? "" : "e"})
        </div>
      </div>
    `);
  }

  /* Outro */
  cards.push(`
    <div class="review-card">
      <div>
        <div class="eyebrow">Weiter so</div>
        <div class="headline">Danke für deine Aufmerksamkeit ✨</div>
        <div class="sub">Jedes Check-in macht das Bild deines Selbst klarer.</div>
      </div>
      <div style="text-align:center">
        <div class="number">${totalEntries}</div>
        <div class="sub">Check-ins in dieser ${period === "week" ? "Woche" : "Monatsphase"}</div>
      </div>
    </div>
  `);

  return cards;
}

let currentReviewPeriod = "week";

function renderReview(period) {
  currentReviewPeriod = period;
  const strip = document.getElementById("reviewStrip");
  const dots = document.getElementById("reviewDots");
  if (!strip || !dots) return;
  const cards = buildReviewCards(period);
  strip.innerHTML = cards.join("");
  dots.innerHTML = cards.map((_, i) => `<span class="d${i === 0 ? " active" : ""}"></span>`).join("");
  strip.scrollLeft = 0;
  // Toggle UI
  for (const btn of document.querySelectorAll("#reviewToggle button")) {
    btn.setAttribute("aria-checked", btn.dataset.period === period ? "true" : "false");
  }
  // Active-Dot via Scroll-Position
  strip.onscroll = () => {
    const cardW = strip.firstElementChild ? strip.firstElementChild.offsetWidth + 16 : 1;
    const idx = Math.round(strip.scrollLeft / cardW);
    const dotEls = dots.querySelectorAll(".d");
    for (let i = 0; i < dotEls.length; i++) {
      dotEls[i].classList.toggle("active", i === idx);
    }
  };
}

function openReview(period = "week") {
  const overlay = document.getElementById("reviewOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  renderReview(period);
  document.body.style.overflow = "hidden";
}

function closeReview() {
  const overlay = document.getElementById("reviewOverlay");
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = "";
}

function wireReview() {
  const openBtn = document.getElementById("openReviewBtn");
  const closeBtn = document.getElementById("reviewClose");
  const toggle = document.getElementById("reviewToggle");
  const overlay = document.getElementById("reviewOverlay");
  if (!openBtn || !closeBtn || !toggle || !overlay) return;
  openBtn.addEventListener("click", () => openReview(currentReviewPeriod));
  closeBtn.addEventListener("click", closeReview);
  toggle.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-period]");
    if (!btn) return;
    renderReview(btn.dataset.period);
  });
  document.addEventListener("keydown", (ev) => {
    if (!overlay.hidden && ev.key === "Escape") { ev.preventDefault(); closeReview(); }
  });
}

export function initRender() {
  subscribe(renderAll);
  wireRangeBar();
  wireReview();
}
