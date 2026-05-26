/* Node-eigener Test-Runner: `node --test stats.test.js`. Keine Dependencies.
   Deckt vor allem die Stellen ab, die in der Vergangenheit Kalibrierungs-
   Bugs hatten (Fluiditäts-Index) sowie Edge-Cases der Aggregate. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayKey, parseDayKey,
  avg, stddev, median, percentile, bucket,
  computeStats, computeCoverage, computePeriodAggregates, computeFluidityIndex,
  computeBuckets, computeWeekdayMedians,
  filterDataByRange, computeTransitions,
  detectFirstSeenTag, detectFirstSeenCombo, detectDecliningTag, detectRangeShrinking
} from "./stats.js";
import { normalizeTags } from "./format.js";

/* ---------- avg ---------- */
test("avg: leer → null", () => assert.equal(avg([]), null));
test("avg: ein Wert → der Wert", () => assert.equal(avg([5]), 5));
test("avg: mehrere Werte", () => assert.equal(avg([1, 2, 3, 4]), 2.5));

/* ---------- stddev ---------- */
test("stddev: leer → 0", () => assert.equal(stddev([]), 0));
test("stddev: ein Wert → 0", () => assert.equal(stddev([5]), 0));
test("stddev: alle gleich → 0", () => assert.equal(stddev([50, 50, 50]), 0));
test("stddev: 33↔67 → ≈17", () => {
  const s = stddev([33, 67, 33, 67, 33, 67]);
  assert.ok(Math.abs(s - 17) < 0.01, `expected ≈17, got ${s}`);
});
test("stddev: 0↔100 → 50", () => {
  const s = stddev([0, 100, 0, 100]);
  assert.equal(s, 50);
});

/* ---------- median ---------- */
test("median: leer → null", () => assert.equal(median([]), null));
test("median: ungerade", () => assert.equal(median([3, 1, 2]), 2));
test("median: gerade", () => assert.equal(median([1, 2, 3, 4]), 2.5));

/* ---------- percentile ---------- */
test("percentile: leer → null", () => assert.equal(percentile([], 50), null));
test("percentile: median ≡ p50", () => {
  const arr = [1, 2, 3, 4, 5];
  assert.equal(percentile(arr, 50), median(arr));
});
test("percentile: p100 ≡ max", () => assert.equal(percentile([1, 5, 9], 100), 9));
test("percentile: p0 ≡ min", () => assert.equal(percentile([1, 5, 9], 0), 1));

/* ---------- bucket ---------- */
test("bucket: weiblich-Bereich", () => {
  assert.equal(bucket(0), "f");
  assert.equal(bucket(33), "f");
});
test("bucket: fluid-Bereich", () => {
  assert.equal(bucket(34), "n");
  assert.equal(bucket(50), "n");
  assert.equal(bucket(66), "n");
});
test("bucket: männlich-Bereich", () => {
  assert.equal(bucket(67), "m");
  assert.equal(bucket(100), "m");
});

/* ---------- dayKey / parseDayKey roundtrip ---------- */
test("dayKey/parseDayKey: roundtrip", () => {
  const d = new Date(2026, 4, 26); // Mai (Monat 4 = Mai)
  assert.equal(dayKey(d), "2026-05-26");
  const back = parseDayKey("2026-05-26");
  assert.equal(back.getFullYear(), 2026);
  assert.equal(back.getMonth(), 4);
  assert.equal(back.getDate(), 26);
});

/* ---------- computeStats ---------- */
test("computeStats: leerer DATA-Dict", () => {
  const s = computeStats({});
  assert.deepEqual(s.dayAvgs, {});
  assert.deepEqual(s.allEntries, []);
  assert.deepEqual(s.dayKeys, []);
});

test("computeStats: ein Tag, zwei Einträge", () => {
  const data = {
    "2026-05-26": {
      e1: { value: 30, ts: 1000, ort: "Büro", befinden: "ruhig" },
      e2: { value: 70, ts: 2000, ort: "Büro", befinden: "ruhig" }
    }
  };
  const s = computeStats(data);
  assert.equal(s.dayAvgs["2026-05-26"], 50);
  assert.equal(s.dayCounts["2026-05-26"], 2);
  assert.equal(s.daySwings["2026-05-26"], 40);
  assert.equal(s.allEntries.length, 2);
  assert.equal(s.byOrt["Büro"].count, 2);
  assert.equal(s.byBefinden["ruhig"].sum, 100);
});

test("normalizeTags: string, array, null, leer, gemischt", () => {
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags(""), []);
  assert.deepEqual(normalizeTags("  "), []);
  assert.deepEqual(normalizeTags("ruhig"), ["ruhig"]);
  assert.deepEqual(normalizeTags("  ruhig  "), ["ruhig"]);
  assert.deepEqual(normalizeTags(["ruhig", "müde"]), ["ruhig", "müde"]);
  assert.deepEqual(normalizeTags([]), []);
  assert.deepEqual(normalizeTags(["a", "", null, "b"]), ["a", "b"]);
  assert.deepEqual(normalizeTags(["  a  ", "b"]), ["a", "b"]);
});

test("computeStats: Mehrfach-Befinden zählt jeden Tag separat", () => {
  const data = {
    "2026-05-26": {
      e1: { value: 30, ts: 1000, ort: "Büro", befinden: ["ruhig", "müde"] },
      e2: { value: 70, ts: 2000, ort: "Büro", befinden: "ruhig" }
    }
  };
  const s = computeStats(data);
  // ruhig taucht 2× auf (e1+e2), müde 1× (e1)
  assert.equal(s.byBefinden["ruhig"].count, 2);
  assert.equal(s.byBefinden["ruhig"].sum, 100);
  assert.equal(s.byBefinden["müde"].count, 1);
  assert.equal(s.byBefinden["müde"].sum, 30);
  // Combo: Büro×ruhig = 2, Büro×müde = 1
  assert.equal(s.byCombo["Büro␟ruhig"].count, 2);
  assert.equal(s.byCombo["Büro␟müde"].count, 1);
  // Tagesdurchschnitt zählt e1 nur 1× (nicht pro Tag verdoppelt)
  assert.equal(s.dayAvgs["2026-05-26"], 50);
});

test("computeStats: Begleitung als String und Array (Rückwärtskompat)", () => {
  const data = {
    "2026-05-26": {
      e1: { value: 40, ts: 1000, begleitung: "Alex" },
      e2: { value: 60, ts: 2000, begleitung: ["Alex", "Sam"] }
    }
  };
  const s = computeStats(data);
  assert.equal(s.byBegleitung["Alex"].count, 2);
  assert.equal(s.byBegleitung["Alex"].sum, 100);
  assert.equal(s.byBegleitung["Sam"].count, 1);
  assert.equal(s.byBegleitung["Sam"].sum, 60);
});

test("computeStats: Ort × Begleitung und Befinden × Begleitung werden gekreuzt", () => {
  const data = {
    "2026-05-26": {
      e1: {
        value: 40, ts: 1000,
        ort: "Büro",
        befinden: ["müde", "fröhlich"],
        begleitung: ["Anna", "Ben"]
      },
      e2: {
        value: 60, ts: 2000,
        ort: "Büro",
        befinden: "müde",
        begleitung: "Anna"
      }
    }
  };
  const s = computeStats(data);
  // Ort × Begleitung: e1 erzeugt Büro×Anna und Büro×Ben, e2 nur Büro×Anna
  assert.equal(s.byOrtBegleitung["Büro␟Anna"].count, 2);
  assert.equal(s.byOrtBegleitung["Büro␟Anna"].sum, 100);
  assert.equal(s.byOrtBegleitung["Büro␟Ben"].count, 1);
  assert.equal(s.byOrtBegleitung["Büro␟Ben"].sum, 40);
  // Befinden × Begleitung: e1 erzeugt 4 Kombis, e2 fügt müde×Anna ein zweites Mal hinzu
  assert.equal(s.byBefindenBegleitung["müde␟Anna"].count, 2);
  assert.equal(s.byBefindenBegleitung["müde␟Anna"].sum, 100);
  assert.equal(s.byBefindenBegleitung["müde␟Ben"].count, 1);
  assert.equal(s.byBefindenBegleitung["müde␟Ben"].sum, 40);
  assert.equal(s.byBefindenBegleitung["fröhlich␟Anna"].count, 1);
  assert.equal(s.byBefindenBegleitung["fröhlich␟Anna"].sum, 40);
  assert.equal(s.byBefindenBegleitung["fröhlich␟Ben"].count, 1);
  assert.equal(s.byBefindenBegleitung["fröhlich␟Ben"].sum, 40);
});

test("computeStats: Begleitung ohne Ort oder Befinden erzeugt keine Combo", () => {
  const data = {
    "2026-05-26": {
      e1: { value: 50, ts: 1000, begleitung: "Anna" }
    }
  };
  const s = computeStats(data);
  assert.deepEqual(s.byOrtBegleitung, {});
  assert.deepEqual(s.byBefindenBegleitung, {});
  assert.equal(s.byBegleitung["Anna"].count, 1);
});

test("computeStats: ohne Tags bleibt byBegleitung leer", () => {
  const data = {
    "2026-05-26": {
      e1: { value: 50, ts: 1000 }
    }
  };
  const s = computeStats(data);
  assert.deepEqual(s.byBegleitung, {});
});

test("computeStats: legacy `situation` wird als `ort` gelesen", () => {
  const data = {
    "2026-05-26": {
      e1: { value: 50, ts: 1000, situation: "Café" }
    }
  };
  const s = computeStats(data);
  assert.equal(s.allEntries[0].ort, "Café");
  assert.equal(s.byOrt["Café"].count, 1);
});

test("computeStats: NaN-Werte werden übersprungen", () => {
  const data = {
    "2026-05-26": {
      e1: { value: "garbage", ts: 1000 },
      e2: { value: 50, ts: 2000 }
    }
  };
  const s = computeStats(data);
  assert.equal(s.allEntries.length, 1);
  assert.equal(s.dayAvgs["2026-05-26"], 50);
});

/* ---------- computeFluidityIndex ---------- */
function statsFromEntries(entries) {
  // Hilfsfunktion: baut ein minimales stats-Objekt für FluidityIndex-Tests
  const data = {};
  for (const e of entries) {
    if (!data[e.dk]) data[e.dk] = {};
    data[e.dk][`id-${Object.keys(data[e.dk]).length}`] = { value: e.value, ts: e.ts ?? 0 };
  }
  return computeStats(data);
}

test("computeFluidityIndex: < 2 Einträge → score null", () => {
  const r = computeFluidityIndex(statsFromEntries([]));
  assert.equal(r.score, null);
  assert.equal(r.label, "noch zu wenig Daten");
});

test("computeFluidityIndex: 2 Einträge → score gerechnet, aber low-confidence", () => {
  const r = computeFluidityIndex(statsFromEntries([
    { dk: "2026-05-26", value: 33 },
    { dk: "2026-05-26", value: 67 }
  ]));
  assert.ok(r.score >= 0);
  assert.equal(r.lowConfidence, true);
  assert.equal(r.label, "noch zu wenig Daten");
});

test("computeFluidityIndex: alle gleich → score 0, sehr stabil", () => {
  const r = computeFluidityIndex(statsFromEntries([
    { dk: "2026-05-26", value: 50 },
    { dk: "2026-05-27", value: 50 },
    { dk: "2026-05-28", value: 50 },
    { dk: "2026-05-29", value: 50 },
    { dk: "2026-05-30", value: 50 },
    { dk: "2026-05-31", value: 50 },
    { dk: "2026-06-01", value: 50 }
  ]));
  assert.equal(r.score, 0);
  assert.equal(r.label, "sehr stabil");
});

test("computeFluidityIndex: 33↔67 über genug Tage → ~fluid", () => {
  const entries = [];
  for (let i = 0; i < 8; i++) {
    entries.push({ dk: `2026-05-${10 + i}`, value: i % 2 ? 33 : 67 });
  }
  const r = computeFluidityIndex(statsFromEntries(entries));
  assert.equal(r.label, "fluid");
  assert.ok(r.score >= 40 && r.score <= 60, `score should be mid-range, got ${r.score}`);
});

test("computeFluidityIndex: 17↔83 über genug Tage → extrem fluid", () => {
  const entries = [];
  for (let i = 0; i < 8; i++) {
    entries.push({ dk: `2026-05-${10 + i}`, value: i % 2 ? 17 : 83 });
  }
  const r = computeFluidityIndex(statsFromEntries(entries));
  assert.equal(r.label, "extrem fluid");
  assert.ok(r.score >= 80, `score should saturate, got ${r.score}`);
});

test("computeFluidityIndex: 7+ Einträge an < 3 Tagen → low-confidence", () => {
  const entries = [];
  for (let i = 0; i < 8; i++) {
    entries.push({ dk: "2026-05-26", value: i % 2 ? 30 : 70 });
  }
  const r = computeFluidityIndex(statsFromEntries(entries));
  assert.equal(r.lowConfidence, true);
});

/* ---------- computeCoverage ---------- */
test("computeCoverage: leere stats → null", () => {
  const r = computeCoverage({ dayKeys: [] });
  assert.equal(r, null);
});

test("computeCoverage: dichte Erfassung", () => {
  const now = new Date(2026, 4, 26); // 26.5.2026
  const stats = { dayKeys: ["2026-05-20", "2026-05-21", "2026-05-26"] };
  const r = computeCoverage(stats, now);
  assert.equal(r.firstKey, "2026-05-20");
  assert.equal(r.daysSinceFirst, 7);
  assert.equal(r.trackedDays, 3);
  // Lücke zwischen 2026-05-21 und 2026-05-26 = 4 Tage dazwischen
  assert.equal(r.longestGap, 4);
  assert.equal(r.gapDk, "2026-05-26");
  assert.equal(r.currentGap, 0);
});

/* ---------- computePeriodAggregates ---------- */
test("computePeriodAggregates: Wochenfenster umfasst heute + 6 Vortage", () => {
  const now = new Date(2026, 4, 26); // 26.5.2026
  const dayAvgs = {};
  // 8 Tage zurück bis heute eintragen
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    dayAvgs[dayKey(d)] = 50;
  }
  const stats = { dayAvgs, dayKeys: Object.keys(dayAvgs).sort() };
  const r = computePeriodAggregates(stats, now);
  // Erwartet: 7 Tage im Wochenfenster (heute + 6 Tage zurück), 8 davon im Monatsfenster
  assert.equal(r.weekDays, 7);
  assert.equal(r.monthDays, 8);
  assert.equal(r.today, dayKey(now));
  assert.equal(r.todayAvg, 50);
});

test("computePeriodAggregates: allAvg gemittelt", () => {
  const now = new Date(2026, 4, 26);
  const dayAvgs = { "2026-05-26": 30, "2026-05-25": 70 };
  const stats = { dayAvgs, dayKeys: ["2026-05-25", "2026-05-26"] };
  const r = computePeriodAggregates(stats, now);
  assert.equal(r.allAvg, 50);
});

/* ---------- computeBuckets ---------- */
test("computeBuckets: leer → total 0, alle Pct 0", () => {
  const r = computeBuckets({ dayAvgs: {} });
  assert.equal(r.total, 0);
  assert.equal(r.pctF, 0);
  assert.equal(r.pctN, 0);
  assert.equal(r.pctM, 0);
});

test("computeBuckets: drei Tage je ein Bucket", () => {
  const r = computeBuckets({ dayAvgs: { a: 10, b: 50, c: 80 } });
  assert.equal(r.f, 1);
  assert.equal(r.n, 1);
  assert.equal(r.m, 1);
  assert.equal(r.total, 3);
  assert.ok(Math.abs(r.pctF - 33.333) < 0.01);
});

/* ---------- computeWeekdayMedians ---------- */
test("computeWeekdayMedians: 7 Einträge, einer pro Wochentag", () => {
  // 2026-05-25 = Mo, 2026-05-26 = Di, … 2026-05-31 = So
  const dayAvgs = {
    "2026-05-25": 10, "2026-05-26": 20, "2026-05-27": 30,
    "2026-05-28": 40, "2026-05-29": 50, "2026-05-30": 60, "2026-05-31": 70
  };
  const r = computeWeekdayMedians({ dayAvgs });
  assert.equal(r.length, 7);
  assert.equal(r[0].name, "Mo");
  assert.equal(r[0].median, 10);
  assert.equal(r[6].name, "So");
  assert.equal(r[6].median, 70);
  assert.equal(r[0].n, 1);
  assert.equal(r[0].lowN, true); // < 3 → low-confidence
});

test("computeWeekdayMedians: leerer Tag → null Median, lowN false", () => {
  const r = computeWeekdayMedians({ dayAvgs: {} });
  for (const day of r) {
    assert.equal(day.median, null);
    assert.equal(day.n, 0);
    assert.equal(day.lowN, false);
  }
});

/* ---------- filterDataByRange (#8) ---------- */
test("filterDataByRange: 'all' und unbekannt geben Original zurück", () => {
  const data = { "2026-05-26": { e1: { value: 50, ts: 0 } } };
  assert.strictEqual(filterDataByRange(data, "all"), data);
  assert.strictEqual(filterDataByRange(data, ""), data);
  assert.strictEqual(filterDataByRange(data, "xyz"), data);
});

test("filterDataByRange: 7d nimmt nur die letzten 7 Kalendertage", () => {
  const now = new Date(2026, 4, 26); // Di 26. Mai 2026
  const data = {
    "2026-05-26": { e: { value: 50, ts: 0 } }, // heute
    "2026-05-20": { e: { value: 50, ts: 0 } }, // 6 Tage vorher — inkludiert
    "2026-05-19": { e: { value: 50, ts: 0 } }, // 7 Tage vorher — knapp draußen
    "2026-04-01": { e: { value: 50, ts: 0 } }, // weit weg
  };
  const r = filterDataByRange(data, "7d", now);
  assert.ok(r["2026-05-26"]);
  assert.ok(r["2026-05-20"]);
  assert.equal(r["2026-05-19"], undefined);
  assert.equal(r["2026-04-01"], undefined);
});

test("filterDataByRange: 1y nimmt 365 Tage", () => {
  const now = new Date(2026, 4, 26);
  const data = {
    "2025-05-27": { e: { value: 50, ts: 0 } }, // 365 Tage vorher → genau die Kante
    "2025-05-26": { e: { value: 50, ts: 0 } }, // 366 Tage vorher → raus
  };
  const r = filterDataByRange(data, "1y", now);
  assert.ok(r["2025-05-27"]);
  assert.equal(r["2025-05-26"], undefined);
});

/* ---------- computeTransitions (#11) ---------- */
test("computeTransitions: leere Stats → alle Counts 0", () => {
  const s = computeStats({});
  const t = computeTransitions(s);
  assert.equal(t.total, 0);
  for (const row of t.counts) for (const c of row) assert.equal(c, 0);
});

test("computeTransitions: drei aufeinander folgende ♀-Tage → 2 f→f Übergänge", () => {
  const data = {
    "2026-05-24": { e: { value: 10, ts: 1 } },
    "2026-05-25": { e: { value: 15, ts: 2 } },
    "2026-05-26": { e: { value: 20, ts: 3 } },
  };
  const s = computeStats(data);
  const t = computeTransitions(s);
  assert.equal(t.counts[0][0], 2);   // f→f
  assert.equal(t.total, 2);
  assert.equal(t.probs[0][0], 1);
});

test("computeTransitions: ein f→m-Wechsel über Tageskante", () => {
  const data = {
    "2026-05-25": { e: { value: 10, ts: 1 } }, // f
    "2026-05-26": { e: { value: 90, ts: 2 } }, // m
  };
  const s = computeStats(data);
  const t = computeTransitions(s);
  assert.equal(t.counts[0][2], 1);  // f → m
  assert.equal(t.total, 1);
});

test("computeTransitions: Lücke zwischen Tagen wird übersprungen", () => {
  const data = {
    "2026-05-20": { e: { value: 10, ts: 1 } }, // f
    "2026-05-26": { e: { value: 90, ts: 2 } }, // m, 6 Tage später
  };
  const s = computeStats(data);
  const t = computeTransitions(s);
  assert.equal(t.total, 0); // kein Direkt-Nachbar
});

/* ---------- detectFirstSeenTag (#17) ---------- */
test("detectFirstSeenTag: Ort, der erstmals heute auftaucht", () => {
  const now = new Date(2026, 4, 26);
  const data = {
    "2026-05-26": { e: { value: 50, ts: now.getTime() - 1000, ort: "Neuer Ort" } }
  };
  const s = computeStats(data);
  const r = detectFirstSeenTag(s, "ort", 14, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "Neuer Ort");
  assert.equal(r[0].count, 1);
});

test("detectFirstSeenTag: Ort vor Fenster ist nicht neu", () => {
  const now = new Date(2026, 4, 26);
  const longAgo = new Date(2026, 0, 1).getTime();
  const data = {
    "2026-01-01": { a: { value: 50, ts: longAgo, ort: "Büro" } },
    "2026-05-26": { b: { value: 50, ts: now.getTime() - 1000, ort: "Büro" } }
  };
  const s = computeStats(data);
  const r = detectFirstSeenTag(s, "ort", 14, now);
  assert.equal(r.length, 0);
});

/* ---------- detectFirstSeenCombo (#17) ---------- */
test("detectFirstSeenCombo: Ort×Befinden erstmals im Fenster", () => {
  const now = new Date(2026, 4, 26);
  const data = {
    "2026-05-26": { e: { value: 50, ts: now.getTime() - 1000, ort: "Büro", befinden: "entspannt" } }
  };
  const s = computeStats(data);
  const r = detectFirstSeenCombo(s, 14, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].ort, "Büro");
  assert.equal(r[0].befinden, "entspannt");
});

/* ---------- detectDecliningTag (#17) ---------- */
test("detectDecliningTag: Tag mit -65% Frequenz erkennt Decline", () => {
  const now = new Date(2026, 4, 26);
  const dayMs = 86400000;
  // Prior-Fenster: 30–60 Tage vor heute → 10 Vorkommen
  // Recent-Fenster: 0–29 Tage vor heute → 3 Vorkommen
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push({ id: "p" + i, value: 50, ts: now.getTime() - (30 + i) * dayMs, befinden: "gestresst" });
  }
  for (let i = 0; i < 3; i++) {
    entries.push({ id: "r" + i, value: 50, ts: now.getTime() - i * dayMs, befinden: "gestresst" });
  }
  // In data-Form bringen
  const data = {};
  for (const e of entries) {
    const d = new Date(e.ts);
    const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!data[dk]) data[dk] = {};
    data[dk][e.id] = { value: e.value, ts: e.ts, befinden: e.befinden };
  }
  const s = computeStats(data);
  const r = detectDecliningTag(s, "befinden", 30, 5, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "gestresst");
  assert.equal(r[0].prior, 10);
  assert.equal(r[0].recent, 3);
  assert.ok(r[0].drop > 0.5);
});

test("detectDecliningTag: stabile Frequenz wird nicht erkannt", () => {
  const now = new Date(2026, 4, 26);
  const dayMs = 86400000;
  const data = {};
  for (let i = 0; i < 6; i++) {
    const ts = now.getTime() - (5 + i * 5) * dayMs;
    const d = new Date(ts);
    const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!data[dk]) data[dk] = {};
    data[dk]["e" + i] = { value: 50, ts, befinden: "gestresst" };
  }
  const s = computeStats(data);
  const r = detectDecliningTag(s, "befinden", 30, 5, now);
  assert.equal(r.length, 0);
});

/* ---------- detectRangeShrinking (#17) ---------- */
test("detectRangeShrinking: stabilere letzte 14 Tage werden erkannt", () => {
  const now = new Date(2026, 4, 26);
  const dayMs = 86400000;
  // Recent (Tag 0..13): alle Werte 50 → σ ≈ 0
  // Prior (Tag 14..27): Werte schwanken 20↔80 → σ ≈ 30
  const data = {};
  for (let i = 0; i < 14; i++) {
    const ts = now.getTime() - i * dayMs;
    const d = new Date(ts);
    const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    data[dk] = { e: { value: 50, ts } };
  }
  for (let i = 14; i < 28; i++) {
    const ts = now.getTime() - i * dayMs;
    const d = new Date(ts);
    const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    data[dk] = { e: { value: i % 2 ? 20 : 80, ts } };
  }
  const s = computeStats(data);
  const r = detectRangeShrinking(s, 14, 7, now);
  assert.equal(r.found, true);
  assert.ok(r.sdRecent < r.sdPrior * 0.5);
});

test("detectRangeShrinking: zu wenig Daten → found false", () => {
  const s = computeStats({});
  const r = detectRangeShrinking(s, 14, 7, new Date(2026, 4, 26));
  assert.equal(r.found, false);
});
