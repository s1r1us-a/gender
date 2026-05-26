/* Pure Format-/Color-/Scale-Helpers. Kein DOM, kein State.
   Werden von render.js und ui.js gleichermaßen verwendet. */

const PINK = [255, 111, 181];
const BLUE = [111, 181, 255];
const lerp = (a, b, t) => a + (b - a) * t;

/* 7-stufige semantische Skala. Werte bleiben auf 0–100-Achse, damit alle
   bestehenden Statistiken, Farben und gespeicherten Daten kompatibel sind. */
export const SCALE = [
  { v: 0,   label: "sehr weiblich",   tick: "♀♀" },
  { v: 17,  label: "weiblich",        tick: "♀"  },
  { v: 33,  label: "leicht weiblich", tick: "♀·" },
  { v: 50,  label: "neutral · fluid", tick: "⚧"  },
  { v: 67,  label: "leicht männlich", tick: "·♂" },
  { v: 83,  label: "männlich",        tick: "♂"  },
  { v: 100, label: "sehr männlich",   tick: "♂♂" }
];

export function scaleIndexFromValue(v) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < SCALE.length; i++) {
    const d = Math.abs(SCALE[i].v - v);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

export function valueToColor(v) {
  const t = Math.max(0, Math.min(1, v / 100));
  const r = Math.round(lerp(PINK[0], BLUE[0], t));
  const g = Math.round(lerp(PINK[1], BLUE[1], t));
  const b = Math.round(lerp(PINK[2], BLUE[2], t));
  return { r, g, b, hex: "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("") };
}

/* WCAG-relative-Luminanz – verlässlicher als einfache Helligkeitsmittel,
   weil Grün viel stärker zur wahrgenommenen Helligkeit beiträgt als Blau. */
export function relLuminance({ r, g, b }) {
  const toLin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

/* Liefert dunkle/helle Textfarbe je nach Hintergrund-Luminanz. */
export function contrastText(c) {
  return relLuminance(c) > 0.45 ? "#1a0f29" : "#fff";
}

export function valueToSymbol(v) {
  if (v <= 25) return "♀";
  if (v <= 42) return "♀⚧";
  if (v <= 58) return "⚧";
  if (v <= 75) return "⚧♂";
  return "♂";
}

/* Hero zeigt nur EIN dominantes Symbol – sonst kollidieren die
   großen iOS-Emoji-Glyphen mit der Zahl daneben. */
export function valueToHeroSymbol(v) {
  if (v <= 33) return "♀";
  if (v <= 66) return "⚧";
  return "♂";
}

export function valueToLabel(v) {
  return SCALE[scaleIndexFromValue(v)].label;
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function setText(id, t) {
  const el = document.getElementById(id);
  if (el) el.textContent = t;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[ch]));
}
