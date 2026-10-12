// Display units (Q14). Frames keep their stored units (kt, °F at 2 m, °C at
// 850 mb, m); views convert what they show.

export type SpeedUnit = "kt" | "mph";
export type TempUnit = "F" | "C";

export interface Units {
  speed: SpeedUnit;
  temp: TempUnit;
}

export const DEFAULT_UNITS: Units = { speed: "kt", temp: "F" };

const MPH_PER_KT = 1.150779;

/**
 * A quantity as shown: its unit, and conversions from (and back to) the
 * stored value. `scale` converts a difference, which has no offset.
 */
export interface Quantity {
  unit: string;
  from: (v: number) => number;
  to: (v: number) => number;
  scale: number;
}

/** A quantity shown as stored. */
export const asStored = (unit: string): Quantity => ({ unit, from: (v) => v, to: (v) => v, scale: 1 });

/** Wind speed stored in knots. */
export function speedQ(u: Units): Quantity {
  return u.speed === "mph"
    ? { unit: "mph", from: (v) => v * MPH_PER_KT, to: (v) => v / MPH_PER_KT, scale: MPH_PER_KT }
    : asStored("kt");
}

/** A temperature stored in `stored` (°F at 2 m, °C at 850 mb). */
export function tempQ(u: Units, stored: TempUnit): Quantity {
  if (u.temp === stored) return asStored(`°${stored}`);
  return u.temp === "C"
    ? { unit: "°C", from: (f) => ((f - 32) * 5) / 9, to: (c) => (c * 9) / 5 + 32, scale: 5 / 9 }
    : { unit: "°F", from: (c) => (c * 9) / 5 + 32, to: (f) => ((f - 32) * 5) / 9, scale: 9 / 5 };
}

/** The other temperature unit, for a hover readout's "(…)". */
export function otherTemp(u: Units): Units {
  return { ...u, temp: u.temp === "F" ? "C" : "F" };
}

/** A 500 mb height difference stored in metres, shown in decametres like the contours. */
export const DAM: Quantity = { unit: "dam", from: (m) => m / 10, to: (d) => d * 10, scale: 0.1 };

/**
 * Colorbar ticks every `every` display units across a stored range, as stored
 * values (so the bar's positions stay in stored units), with their labels.
 */
export function ticksIn(q: Quantity, min: number, max: number, every: number) {
  const [a, b] = [q.from(min), q.from(max)].sort((x, y) => x - y);
  const ticks: number[] = [];
  for (let d = Math.ceil(a / every - 1e-9) * every; d <= b + 1e-9; d += every) ticks.push(q.to(d));
  return { ticks: ticks.sort((x, y) => x - y), format: (v: number) => String(Math.round(q.from(v))) };
}
