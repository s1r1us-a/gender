/* Statistik- und Compute-Funktionen — purer Code ohne DOM-Zugriff.
   Jede Funktion ist deterministisch über ihre Argumente und ohne globalen
   State testbar (siehe stats.test.js). Zeit-abhängige Funktionen nehmen
   einen optionalen `now`-Parameter, damit Tests Datum/Uhrzeit pinnen können. */

import { normalizeTags } from "./format.js";

/* ---------- Datum-Helper ---------- */
export function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function parseDayKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/* ---------- Reine Math-Helper ---------- */
export function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length);
}
export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
export function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * (p / 100);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/* ---------- Klassifikation ---------- */
export function bucket(v) {
  if (v <= 33) return "f";
  if (v <= 66) return "n";
  return "m";
}

/* ---------- Aggregation ---------- */
export function computeStats(data) {
  const dayKeys = Object.keys(data).sort();
  const dayAvgs = {};
  const dayCounts = {};
  const daySwings = {};
  const allEntries = [];
  const byOrt = {};
  const byBefinden = {};
  const byBegleitung = {};
  const byCombo = {};
  const addTo = (bucketMap, name, v) => {
    if (!name) return;
    if (!bucketMap[name]) bucketMap[name] = { sum: 0, count: 0 };
    bucketMap[name].sum += v;
    bucketMap[name].count += 1;
  };
  for (const dk of dayKeys) {
    const vals = [];
    for (const id in data[dk]) {
      const e = data[dk][id];
      const v = Number(e.value);
      if (isNaN(v)) continue;
      vals.push(v);
      const ort = (e.ort ?? e.situation ?? "").trim();
      const befindenTags = normalizeTags(e.befinden);
      const begleitungTags = normalizeTags(e.begleitung);
      allEntries.push({
        dk, id, value: v, ts: e.ts, ort,
        befinden: befindenTags,
        begleitung: begleitungTags
      });
      addTo(byOrt, ort, v);
      for (const b of befindenTags) addTo(byBefinden, b, v);
      for (const g of begleitungTags) addTo(byBegleitung, g, v);
      if (ort && befindenTags.length) {
        for (const b of befindenTags) {
          const key = ort + "␟" + b;
          if (!byCombo[key]) byCombo[key] = { ort, befinden: b, sum: 0, count: 0 };
          byCombo[key].sum += v;
          byCombo[key].count += 1;
        }
      }
    }
    if (vals.length) {
      dayAvgs[dk] = avg(vals);
      dayCounts[dk] = vals.length;
      if (vals.length >= 2) daySwings[dk] = Math.max(...vals) - Math.min(...vals);
    }
  }
  return {
    dayAvgs, dayCounts, daySwings,
    allEntries, byOrt, byBefinden, byBegleitung, byCombo,
    dayKeys: Object.keys(dayAvgs).sort()
  };
}

export function computeCoverage(stats, now = new Date()) {
  const keys = stats.dayKeys;
  if (!keys.length) return null;
  const firstKey = keys[0];
  const first = parseDayKey(firstKey);
  const todayMid = new Date(now); todayMid.setHours(0, 0, 0, 0);
  const daysSinceFirst = Math.round((todayMid - first) / 86400000) + 1;
  const trackedDays = keys.length;
  const coveragePct = daysSinceFirst > 0 ? (trackedDays / daysSinceFirst) * 100 : 0;
  let longestGap = 0, gapDk = null;
  for (let i = 1; i < keys.length; i++) {
    const prev = parseDayKey(keys[i - 1]);
    const cur = parseDayKey(keys[i]);
    const gap = Math.round((cur - prev) / 86400000) - 1;
    if (gap > longestGap) { longestGap = gap; gapDk = keys[i]; }
  }
  const lastKey = keys[keys.length - 1];
  const lastDate = parseDayKey(lastKey);
  const currentGap = Math.max(0, Math.round((todayMid - lastDate) / 86400000));
  return { firstKey, daysSinceFirst, trackedDays, coveragePct, longestGap, gapDk, currentGap };
}

export function computePeriodAggregates(stats, now = new Date()) {
  const today = dayKey(now);
  const todayAvg = stats.dayAvgs[today] ?? null;
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 6); weekAgo.setHours(0, 0, 0, 0);
  const monthAgo = new Date(now); monthAgo.setDate(monthAgo.getDate() - 29); monthAgo.setHours(0, 0, 0, 0);
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
    allDayAvgs, allAvg: avg(allDayAvgs),
    trackedDays: stats.dayKeys.length
  };
}

export function computeFluidityIndex(stats) {
  const dayVals = Object.values(stats.dayAvgs);
  const entryVals = stats.allEntries.map(e => e.value);
  if (entryVals.length < 2) return { score: null, sdEntries: 0, sdDays: 0, label: "noch zu wenig Daten" };
  const sdEntries = stddev(entryVals);
  const sdDays = dayVals.length >= 2 ? stddev(dayVals) : 0;
  /* Kalibrierung gegen die 7-stufige Skala {0,17,33,50,67,83,100}:
     - Pendeln 33↔67 (eine Stufe um Neutral) ergibt σ≈17 → ~"fluid".
     - Pendeln 17↔83 ergibt σ≈33 → "extrem fluid".
     - Theoretisches Max 0↔100 ergibt σ=50, score sättigt auf 100. */
  const score = Math.max(0, Math.min(100, Math.round(sdEntries / 35 * 100)));
  if (entryVals.length < 7 || dayVals.length < 3) {
    return { score, sdEntries, sdDays, label: "noch zu wenig Daten", lowConfidence: true };
  }
  let label;
  if (score <= 20)      label = "sehr stabil";
  else if (score <= 40) label = "leicht fluid";
  else if (score <= 60) label = "fluid";
  else if (score <= 80) label = "sehr fluid";
  else                  label = "extrem fluid";
  return { score, sdEntries, sdDays, label };
}

/* Aggregation für die Drei-Bucket-Anzeige (weiblich/fluid/männlich). */
export function computeBuckets(stats) {
  let f = 0, n = 0, m = 0;
  for (const v of Object.values(stats.dayAvgs)) {
    const b = bucket(v);
    if (b === "f") f++;
    else if (b === "n") n++;
    else m++;
  }
  const total = f + n + m;
  const denom = total || 1;
  return {
    f, n, m, total,
    pctF: f / denom * 100,
    pctN: n / denom * 100,
    pctM: m / denom * 100
  };
}

/* ---------- Zeitfenster-Filter (#8) ----------
   Filtert die Roh-DATA-Struktur (dayKey → entryId → Entry) auf einen
   Zeitraum. Cutoff inkludiert "heute" + (days-1) Vortage. */
export function filterDataByRange(data, range, now = new Date()) {
  if (!range || range === "all") return data;
  const days = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 }[range];
  if (!days) return data;
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const out = {};
  for (const dk in data) {
    if (parseDayKey(dk) >= cutoff) out[dk] = data[dk];
  }
  return out;
}

/* ---------- Übergangswahrscheinlichkeiten (#11) ----------
   3×3-Markov-Matrix: Bucket-Übergänge zwischen aufeinanderfolgenden
   Tagen. counts[i][j] = wie oft folgte auf Bucket i Bucket j am
   direkten Folgetag. Nicht-zusammenhängende Tage werden übersprungen. */
const BUCKETS = ["f", "n", "m"];
export function computeTransitions(stats) {
  const counts = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const keys = stats.dayKeys;
  for (let i = 0; i < keys.length - 1; i++) {
    const today = parseDayKey(keys[i]);
    const next = parseDayKey(keys[i + 1]);
    // Math.round schützt gegen DST-Drift
    if (Math.round((next - today) / 86400000) !== 1) continue;
    const r = BUCKETS.indexOf(bucket(stats.dayAvgs[keys[i]]));
    const c = BUCKETS.indexOf(bucket(stats.dayAvgs[keys[i + 1]]));
    if (r < 0 || c < 0) continue;
    counts[r][c]++;
  }
  const rowTotals = counts.map(row => row.reduce((a, b) => a + b, 0));
  const probs = counts.map((row, r) => {
    const tot = rowTotals[r];
    return row.map(c => tot > 0 ? c / tot : null);
  });
  const total = rowTotals.reduce((a, b) => a + b, 0);
  return { counts, rowTotals, probs, total };
}

/* ---------- Insight-Detektoren (#17) ----------
   Reine Funktionen, die Muster im Stats-Objekt erkennen. Geben
   strukturierte Daten zurück (kein Text), damit der Renderer die
   Sprache übernimmt und die Detektoren testbar bleiben. */

/* Orte/Befinden/Begleitung, die innerhalb der letzten `windowDays` erstmals
   auftauchen. Bei Array-Tags (befinden, begleitung) wird jeder Tag einzeln
   bewertet. */
export function detectFirstSeenTag(stats, tagField, windowDays = 14, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (windowDays - 1));
  const cutoffMs = cutoff.getTime();
  const earliest = {};
  const countInWindow = {};
  let valueSumInWindow = {};
  for (const e of stats.allEntries) {
    if (!Number.isFinite(e.ts)) continue;
    const raw = e[tagField];
    const tags = Array.isArray(raw)
      ? raw
      : (raw ? [String(raw).trim()] : []);
    for (const tagRaw of tags) {
      const tag = (tagRaw || "").trim();
      if (!tag) continue;
      if (earliest[tag] == null || e.ts < earliest[tag]) earliest[tag] = e.ts;
      if (e.ts >= cutoffMs) {
        countInWindow[tag] = (countInWindow[tag] || 0) + 1;
        valueSumInWindow[tag] = (valueSumInWindow[tag] || 0) + e.value;
      }
    }
  }
  const out = [];
  for (const tag in earliest) {
    if (earliest[tag] >= cutoffMs) {
      const n = countInWindow[tag] || 0;
      out.push({
        name: tag,
        count: n,
        avg: n ? valueSumInWindow[tag] / n : null,
        firstTs: earliest[tag]
      });
    }
  }
  // Häufigster zuerst.
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"));
  return out;
}

/* Ort×Befinden-Kombos, die innerhalb der letzten `windowDays` erstmals
   auftauchen. */
export function detectFirstSeenCombo(stats, windowDays = 14, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (windowDays - 1));
  const cutoffMs = cutoff.getTime();
  const earliest = {};
  const counts = {};
  for (const e of stats.allEntries) {
    const ort = (e.ort || "").trim();
    if (!ort) continue;
    if (!Number.isFinite(e.ts)) continue;
    const befTags = Array.isArray(e.befinden)
      ? e.befinden
      : (e.befinden ? [String(e.befinden).trim()] : []);
    for (const befRaw of befTags) {
      const bef = (befRaw || "").trim();
      if (!bef) continue;
      const key = ort + "␟" + bef;
      if (earliest[key] == null || e.ts < earliest[key]) earliest[key] = e.ts;
      if (e.ts >= cutoffMs) counts[key] = (counts[key] || 0) + 1;
    }
  }
  const out = [];
  for (const key in earliest) {
    if (earliest[key] >= cutoffMs) {
      const [ort, bef] = key.split("␟");
      out.push({ ort, befinden: bef, count: counts[key] || 0, firstTs: earliest[key] });
    }
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/* Befinden-Tags, deren Frequenz im letzten Fenster <50% des
   vorherigen Fensters ist (jeweils 30 Tage, vorheriges Fenster ≥5
   Vorkommen). */
export function detectDecliningTag(stats, tagField, windowDays = 30, minPriorCount = 5, now = new Date()) {
  const cutoffRecent = new Date(now);
  cutoffRecent.setHours(0, 0, 0, 0);
  cutoffRecent.setDate(cutoffRecent.getDate() - (windowDays - 1));
  const cutoffPrior = new Date(cutoffRecent);
  cutoffPrior.setDate(cutoffPrior.getDate() - windowDays);
  const recentMs = cutoffRecent.getTime();
  const priorMs = cutoffPrior.getTime();
  const recent = {};
  const prior = {};
  for (const e of stats.allEntries) {
    if (!Number.isFinite(e.ts)) continue;
    const raw = e[tagField];
    const tags = Array.isArray(raw)
      ? raw
      : (raw ? [String(raw).trim()] : []);
    for (const tagRaw of tags) {
      const tag = (tagRaw || "").trim();
      if (!tag) continue;
      if (e.ts >= recentMs) recent[tag] = (recent[tag] || 0) + 1;
      else if (e.ts >= priorMs) prior[tag] = (prior[tag] || 0) + 1;
    }
  }
  const out = [];
  for (const tag in prior) {
    if (prior[tag] < minPriorCount) continue;
    const r = recent[tag] || 0;
    if (r >= prior[tag] * 0.5) continue;
    const drop = 1 - r / prior[tag];
    out.push({ name: tag, recent: r, prior: prior[tag], drop });
  }
  out.sort((a, b) => b.drop - a.drop);
  return out;
}

/* True, wenn σ der Tagesmittelwerte im jüngsten Fenster <50% des
   vorhergehenden Fensters ist (jeweils min `minDays` Tage). */
export function detectRangeShrinking(stats, windowDays = 14, minDays = 7, now = new Date()) {
  const cutoffRecent = new Date(now);
  cutoffRecent.setHours(0, 0, 0, 0);
  cutoffRecent.setDate(cutoffRecent.getDate() - (windowDays - 1));
  const cutoffPrior = new Date(cutoffRecent);
  cutoffPrior.setDate(cutoffPrior.getDate() - windowDays);
  const recent = [];
  const prior = [];
  for (const dk in stats.dayAvgs) {
    const d = parseDayKey(dk);
    if (d >= cutoffRecent) recent.push(stats.dayAvgs[dk]);
    else if (d >= cutoffPrior) prior.push(stats.dayAvgs[dk]);
  }
  if (recent.length < minDays || prior.length < minDays) {
    return { found: false, recentDays: recent.length, priorDays: prior.length };
  }
  const sdRecent = stddev(recent);
  const sdPrior = stddev(prior);
  if (sdPrior <= 0) return { found: false, sdRecent, sdPrior };
  const found = sdRecent < sdPrior * 0.5;
  return { found, sdRecent, sdPrior, recentDays: recent.length, priorDays: prior.length };
}

/* Wochentag-Mediane (Mo–So, Mo=0). */
const WEEKDAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
export function computeWeekdayMedians(stats) {
  const buckets = Array.from({ length: 7 }, () => []);
  for (const dk in stats.dayAvgs) {
    const d = parseDayKey(dk);
    const w = (d.getDay() + 6) % 7;
    buckets[w].push(stats.dayAvgs[dk]);
  }
  return buckets.map((vals, i) => ({
    name: WEEKDAY_NAMES[i],
    median: vals.length ? median(vals) : null,
    n: vals.length,
    lowN: vals.length > 0 && vals.length < 3
  }));
}
