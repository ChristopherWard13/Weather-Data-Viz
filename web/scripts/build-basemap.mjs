// Build web/src/assets/basemap-50m.topo.json from Natural Earth 50m vectors.
//
// Run once (npm run basemap); the output is committed so builds need no network.
// Natural Earth is public domain: https://www.naturalearthdata.com/about/terms-of-use/
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { topology } from "topojson-server";
import { presimplify, simplify, quantile } from "topojson-simplify";
import { quantize } from "topojson-client";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(here, "../../config.json"), "utf8"));
const out = join(here, "../src/assets/basemap-50m.topo.json");
const cacheDir = join(here, ".cache");

const BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson";
const LAYERS = {
  coastline: "ne_50m_coastline.geojson",
  countries: "ne_50m_admin_0_boundary_lines_land.geojson",
  states: "ne_50m_admin_1_states_provinces_lines.geojson",
  lakes: "ne_50m_lakes.geojson",
};

// Clip generously beyond the data domain: the conic projection's corners
// reach outside the lat/lon rectangle.
const d = config.domain;
const BBOX = [d.lon_min - 25, d.lat_min - 15, d.lon_max + 25, d.lat_max + 15];

async function load(name) {
  await mkdir(cacheDir, { recursive: true });
  const cached = join(cacheDir, name);
  if (!existsSync(cached)) {
    const res = await fetch(`${BASE}/${name}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    await writeFile(cached, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(await readFile(cached, "utf8"));
}

const inside = ([x, y]) => x >= BBOX[0] && x <= BBOX[2] && y >= BBOX[1] && y <= BBOX[3];

// Split a line into runs of points inside the box, keeping one point either
// side so lines still reach the box edge.
function clipLine(coords) {
  const runs = [];
  let run = null;
  coords.forEach((p, i) => {
    const keep = inside(p) || (i > 0 && inside(coords[i - 1])) || (i + 1 < coords.length && inside(coords[i + 1]));
    if (keep) {
      (run ??= []).push(p);
    } else if (run) {
      if (run.length > 1) runs.push(run);
      run = null;
    }
  });
  if (run && run.length > 1) runs.push(run);
  return runs;
}

function lines(geom) {
  switch (geom?.type) {
    case "LineString":
      return [geom.coordinates];
    case "MultiLineString":
      return geom.coordinates;
    case "Polygon":
      return geom.coordinates;
    case "MultiPolygon":
      return geom.coordinates.flat();
    default:
      return [];
  }
}

// Spherical polygon area in km^2 (outer rings only); used for a size cut.
function polygonAreaKm2(geom) {
  const rad = Math.PI / 180;
  const R = 6371;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  let total = 0;
  for (const poly of polys) {
    const ring = poly[0];
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      a += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
    }
    total += Math.abs((a * R * R) / 2);
  }
  return total;
}

function toMultiLine(fc, filter = () => true) {
  const parts = [];
  for (const f of fc.features) {
    if (!filter(f)) continue;
    for (const line of lines(f.geometry)) parts.push(...clipLine(line));
  }
  return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: parts } };
}

const objects = {};
for (const [key, file] of Object.entries(LAYERS)) {
  const fc = await load(file);
  // Lakes: only the large ones (Great Lakes, Winnipeg, Great Slave, ...).
  const filter = key === "lakes" ? (f) => polygonAreaKm2(f.geometry) > 5000 : undefined;
  objects[key] = toMultiLine(fc, filter);
  console.log(`${key}: ${objects[key].geometry.coordinates.length} line parts`);
}

let topo = topology(objects, 1e5);
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.35));
topo = quantize(topo, 2e4);
const json = JSON.stringify(topo);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, json);
console.log(`wrote ${out} (${(json.length / 1024).toFixed(0)} KB)`);
