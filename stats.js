/* Statistik- und Compute-Funktionen — purer Code ohne DOM-Zugriff.
   Jede Funktion ist deterministisch über ihre Argumente und ohne globalen
   State testbar (siehe stats.test.js). Zeit-abhängige Funktionen nehmen
   einen optionalen `now`-Parameter, damit Tests Datum/Uhrzeit pinnen können. */

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
      const befinden = (e.befinden || "").trim();
      allEntries.push({ dk, id, value: v, ts: e.ts, ort, befinden });
      addTo(byOrt, ort, v);
      addTo(byBefinden, befinden, v);
      if (ort && befinden) {
        const key = ort + "␟" + befinden;
        if (!byCombo[key]) byCombo[key] = { ort, befinden, sum: 0, count: 0 };
        byCombo[key].sum += v;
        byCombo[key].count += 1;
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
    allEntries, byOrt, byBefinden, byCombo,
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
