// Adds jurisdictions that are missing from the 110m world outlines in
// data/boundaries.json (Cayman Islands, Bermuda, Singapore, Malta, ...).
// Outlines come from Natural Earth 50m admin 0 countries, falling back to
// 10m for places 50m leaves out (Gibraltar). Existing 110m outlines are
// kept, so the weather grid's land mask is unchanged. Safe to rerun.
//
//   node scripts/add-small-boundaries.mjs
//
// Downloads are cached in .cache/naturalearth.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const cacheDir = new URL(".cache/naturalearth/", root);
const source = (scale) =>
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_${scale}_admin_0_countries.geojson`;

async function load(scale) {
  const file = new URL(`ne_${scale}_admin_0_countries.geojson`, cacheDir);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {}
  const response = await fetch(source(scale));
  if (!response.ok) throw new Error(`${scale}: HTTP ${response.status}`);
  const text = await response.text();
  await writeFile(file, text);
  return JSON.parse(text);
}

const codeOf = ({ ISO_A2_EH, ISO_A2 }) =>
  [ISO_A2_EH, ISO_A2].find((code) => code && code !== "-99");

// About 10 m of precision; keeps the file small.
const round = (coords) =>
  typeof coords[0] === "number"
    ? coords.map((v) => Math.round(v * 1e4) / 1e4)
    : coords.map(round);

await mkdir(cacheDir, { recursive: true });
const path = new URL("data/boundaries.json", root);
const boundaries = JSON.parse(await readFile(path, "utf8"));
const have = new Set(boundaries.features.map((f) => f.properties.code));
const added = [];
for (const scale of ["50m", "10m"]) {
  for (const { properties, geometry } of (await load(scale)).features) {
    const code = codeOf(properties);
    if (!code || have.has(code)) continue;
    have.add(code);
    added.push({
      type: "Feature",
      properties: { name: properties.NAME_LONG, code, scale },
      geometry: { type: geometry.type, coordinates: round(geometry.coordinates) },
    });
  }
}
boundaries.features.push(...added.sort((a, b) => a.properties.code.localeCompare(b.properties.code)));
await writeFile(path, JSON.stringify(boundaries));
console.log(
  `added ${added.length} outlines: ` +
    added.map((f) => f.properties.code + (f.properties.scale === "10m" ? " (10m)" : "")).join(" "),
);
