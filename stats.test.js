/* Node-eigener Test-Runner: `node --test stats.test.js`. Keine Dependencies.
   Deckt vor allem die Stellen ab, die in der Vergangenheit Kalibrierungs-
   Bugs hatten (Fluiditäts-Index) sowie Edge-Cases der Aggregate. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayKey, parseDayKey,
  avg, stddev, median, percentile, bucket,
  computeStats, computeCoverage, computePeriodAggregates, computeFluidityIndex,
  computeBuckets, computeWeekdayMedians
} from "./stats.js";

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
