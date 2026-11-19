// Builds data/grid.bin.gz: a 1° global land grid of 2025 daily weather from
// NASA POWER (MERRA-2 temperature and dew point, CERES cloud amount).
//
//   node scripts/fetch-grid.mjs
//
// Raw responses are cached in .cache/power so reruns only fetch what is missing.
// Requires Node.js 20 or later and network access to power.larc.nasa.gov.
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const d3 = require("../vendor/d3.min.js");
const root = new URL("../", import.meta.url);
const cacheDir = new URL(".cache/power/", root);
const YEAR = 2025;
const DAYS = 365;
const LAT_MIN = -56; // Antarctica is excluded from the map.
const LAT_MAX = 84;
const CONCURRENCY = 2;

const boundaries = JSON.parse(
  await readFile(new URL("data/boundaries.json", root), "utf8"),
);
const features = boundaries.features
  .filter((f) => f.properties.code !== "AQ")
  .map((f) => ({ f, code: f.properties.code, bounds: d3.geoBounds(f) }));

function inBounds([[x0, y0], [x1, y1]], lon, lat) {
  if (lat < y0 || lat > y1) return false;
  return x0 <= x1 ? lon >= x0 && lon <= x1 : lon >= x0 || lon <= x1;
}

function countryAt(lon, lat) {
  for (const { f, code, bounds } of features)
    if (inBounds(bounds, lon, lat) && d3.geoContains(f, [lon, lat]))
      return code;
  return null;
}

// 1° cells, identified by their south-west corner. A cell is land when any of
// a 4×4 set of sample points falls inside a country outline.
const cells = [];
for (let lat0 = LAT_MIN; lat0 < LAT_MAX; lat0 += 1) {
  for (let lon0 = -180; lon0 < 180; lon0 += 1) {
    const hits = new Map();
    for (const dy of [0.125, 0.375, 0.625, 0.875])
      for (const dx of [0.125, 0.375, 0.625, 0.875]) {
        const code = countryAt(lon0 + dx, lat0 + dy);
        if (code) hits.set(code, (hits.get(code) ?? 0) + 1);
      }
    if (!hits.size) continue;
    const code = [...hits].sort((a, b) => b[1] - a[1])[0][0];
    cells.push({ lat0, lon0, code });
  }
}
console.log(cells.length + " land cells");

// POWER regional requests cover at most 10°×10° and one parameter.
const boxes = new Map();
for (const { lat0, lon0 } of cells) {
  const by = Math.floor(lat0 / 10) * 10;
  const bx = Math.floor(lon0 / 10) * 10;
  boxes.set(by + "," + bx, [by, bx]);
}
console.log(boxes.size + " regions × 3 parameters");

async function fetchBox(param, [by, bx]) {
  const file = new URL(`${param}_${by}_${bx}.json.gz`, cacheDir);
  try {
    return JSON.parse(gunzipSync(await readFile(file)));
  } catch {}
  const url = new URL("https://power.larc.nasa.gov/api/temporal/daily/regional");
  url.search = new URLSearchParams({
    parameters: param,
    community: "RE",
    "latitude-min": by,
    "latitude-max": by + 10,
    "longitude-min": bx,
    "longitude-max": bx + 10,
    start: YEAR + "0101",
    end: YEAR + "1231",
    format: "JSON",
    units: "metric",
  });
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      // Keep only coordinates and values to keep the cache small.
      const points = body.features.map((f) => [
        f.geometry.coordinates[0],
        f.geometry.coordinates[1],
        Object.values(f.properties.parameter[param]),
      ]);
      await writeFile(file, gzipSync(JSON.stringify(points)));
      return points;
    } catch (error) {
      if (attempt >= 8) throw new Error(`${param} ${by},${bx}: ${error.message}`);
      // POWER answers 429 when busy; back off for longer each time.
      await new Promise((r) => setTimeout(r, 15000 * attempt));
    }
  }
}

async function pool(items, worker) {
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await worker(item);
        done += 1;
        if (done % 25 === 0 || done === items.length)
          console.log(`  ${done}/${items.length}`);
      }
    }),
  );
}

await mkdir(cacheDir, { recursive: true });
const cellKey = (lat0, lon0) => lat0 * 1000 + lon0;
const cellIndex = new Map(cells.map((c, i) => [cellKey(c.lat0, c.lon0), i]));
// Per cell: summed values from the met points inside it, split by land/sea.
const acc = {
  T2M_MAX: cells.map(() => ({ land: [], sea: [] })),
  T2MDEW: cells.map(() => ({ land: [], sea: [] })),
};
const cloud = new Array(cells.length).fill(null);
const seen = { T2M_MAX: new Set(), T2MDEW: new Set(), CLOUD_AMT: new Set() };

const jobs = [];
for (const param of ["T2M_MAX", "T2MDEW", "CLOUD_AMT"])
  for (const box of boxes.values()) jobs.push([param, box]);

await pool(jobs, async ([param, box]) => {
  const points = await fetchBox(param, box);
  for (const [lon, lat, values] of points) {
    const key = lon + "," + lat;
    if (seen[param].has(key)) continue;
    seen[param].add(key);
    if (values.length !== DAYS) throw new Error(`${param} ${key}: ${values.length} days`);
    if (param === "CLOUD_AMT") {
      // Cloud is on a 1° grid centred on x.5, one point per cell.
      const i = cellIndex.get(cellKey(Math.floor(lat), Math.floor(lon)));
      if (i !== undefined) cloud[i] = values;
      continue;
    }
    // Met points sit on cell edges; the point at a cell's south-west corner
    // or interior belongs to that cell.
    const i = cellIndex.get(cellKey(Math.floor(lat), Math.floor(lon)));
    if (i === undefined) continue;
    const bucket = countryAt(lon, lat) ? "land" : "sea";
    acc[param][i][bucket].push(values);
  }
});

function cellSeries(entry) {
  const series = entry.land.length ? entry.land : entry.sea;
  if (!series.length) return null;
  return Array.from({ length: DAYS }, (_, day) => {
    let sum = 0;
    let n = 0;
    for (const s of series)
      if (s[day] > -900) {
        sum += s[day];
        n += 1;
      }
    return n ? sum / n : null;
  });
}

const toF = (c) => (c == null ? -128 : Math.max(-127, Math.min(127, Math.round(c * 1.8 + 32))));
const kept = [];
let missing = 0;
for (let i = 0; i < cells.length; i += 1) {
  const highs = cellSeries(acc.T2M_MAX[i]);
  const dews = cellSeries(acc.T2MDEW[i]);
  if (!highs || !dews || !cloud[i]) {
    missing += 1;
    continue;
  }
  kept.push({ ...cells[i], highs, dews, clouds: cloud[i] });
}
console.log(kept.length + " cells kept, " + missing + " without data");

// Layout (little-endian):
//   u32 cellCount, u16 days
//   i16 lat0[n], i16 lon0[n], u16 country[n]
//   i8 high°F[n*days], i8 dew°F[n*days], u8 cloud%[n*days]  (cell-major)
// Missing temperatures are -128 and missing cloud is 255; both never count.
const codes = [...new Set(kept.map((c) => c.code))].sort();
const n = kept.length;
const header = 6 + n * 6;
const buffer = new ArrayBuffer(header + n * DAYS * 3 + ((header + n * DAYS * 3) % 2));
const view = new DataView(buffer);
view.setUint32(0, n, true);
view.setUint16(4, DAYS, true);
kept.forEach((c, i) => {
  view.setInt16(6 + i * 2, c.lat0, true);
  view.setInt16(6 + n * 2 + i * 2, c.lon0, true);
  view.setUint16(6 + n * 4 + i * 2, codes.indexOf(c.code), true);
});
const highs = new Int8Array(buffer, header, n * DAYS);
const dews = new Int8Array(buffer, header + n * DAYS, n * DAYS);
const clouds = new Uint8Array(buffer, header + 2 * n * DAYS, n * DAYS);
kept.forEach((c, i) => {
  for (let d = 0; d < DAYS; d += 1) {
    highs[i * DAYS + d] = toF(c.highs[d]);
    dews[i * DAYS + d] = toF(c.dews[d]);
    const cc = c.clouds[d];
    clouds[i * DAYS + d] = cc > -900 ? Math.round(cc) : 255;
  }
});
const gz = gzipSync(Buffer.from(buffer), { level: 9 });
await writeFile(new URL("data/grid.bin.gz", root), gz);
await writeFile(
  new URL("data/grid.json", root),
  JSON.stringify({ year: YEAR, days: DAYS, cellSize: 1, cells: n, codes }),
);
console.log(
  `wrote data/grid.bin.gz (${(gz.length / 1e6).toFixed(1)} MB, raw ${(buffer.byteLength / 1e6).toFixed(1)} MB)`,
);
