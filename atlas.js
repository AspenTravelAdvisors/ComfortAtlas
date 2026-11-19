const d3 = window.d3;
const el = (id) => document.getElementById(id);
const fields = Object.fromEntries(
  ["low", "high", "dew", "cloud", "tax", "crypto", "unknown"].map((id) => [
    id,
    el(id),
  ]),
);
const cryptoLabels = {
  licensed: "Licensing or registration required",
  partial: "Partial prohibition",
  prohibited: "Explicit prohibition",
  other: "Other or undecided",
};
const cryptoColors = {
  licensed: "#61ad93",
  partial: "#efc374",
  prohibited: "#bb6d7a",
  other: "#9f8bbe",
};
const noData = "Unavailable";
const noDataColor = "#d8dfdd";
// Comfortable days → color. Few places on Earth clear 250 strict days in a
// single year, so the warm end of the scale starts well below 365: red marks
// roughly the top 0.2% of land (California's central coast, coastal Atacama).
const weatherStops = [
  [0, "#fbeef8"],
  [25, "#ecc4ea"],
  [55, "#c3a9e0"],
  [85, "#8fa6dd"],
  [115, "#5fb2e0"],
  [145, "#4fc0b0"],
  [165, "#7cc95e"],
  [185, "#e6dc4f"],
  [205, "#f5a43a"],
  [225, "#e8502e"],
  [250, "#c41a22"],
];
const weatherColor = d3
  .scaleLinear(
    weatherStops.map(([days]) => days),
    weatherStops.map(([, color]) => color),
  )
  .clamp(true);
const weatherTicks = [0, 55, 115, 165, 205, 250];
document.documentElement.style.setProperty(
  "--weather",
  "linear-gradient(90deg, " +
    weatherStops
      .map(([days, color]) => color + " " + ((days / 250) * 100).toFixed(1) + "%")
      .join(", ") +
    ")",
);
const taxColor = d3
  .scaleLinear(
    [0, 15, 30, 45, 60],
    ["#167459", "#8ac4a9", "#f5dfb0", "#d28c76", "#9a4b55"],
  )
  .clamp(true);
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const selection = el("selection");
const sourceRoot = new URL("./data/", import.meta.url);
const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
let layer = "weather";
let active = null;

function node(tag, value, className) {
  const elem = document.createElement(tag);
  if (value !== undefined) elem.textContent = value;
  if (className) elem.className = className;
  return elem;
}

async function getData(name) {
  const response = await fetch(new URL(name + ".json", sourceRoot));
  if (!response.ok) throw new Error(name + " returned HTTP " + response.status);
  return response.json();
}

// Loads the 1° land grid written by scripts/fetch-grid.mjs.
async function getGrid() {
  const [meta, response] = await Promise.all([
    getData("grid"),
    fetch(new URL("grid.bin.gz", sourceRoot)),
  ]);
  if (!response.ok) throw new Error("grid returned HTTP " + response.status);
  let buffer = await response.arrayBuffer();
  // Hosts that send Content-Encoding: gzip hand back the decoded bytes already.
  const magic = new Uint8Array(buffer, 0, 2);
  if (magic[0] === 0x1f && magic[1] === 0x8b)
    buffer = await new Response(
      new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
  const view = new DataView(buffer);
  const n = view.getUint32(0, true);
  const days = view.getUint16(4, true);
  const header = 6 + n * 6;
  const lat0 = new Int16Array(n);
  const lon0 = new Int16Array(n);
  const codes = new Array(n);
  const index = new Map();
  for (let i = 0; i < n; i += 1) {
    lat0[i] = view.getInt16(6 + i * 2, true);
    lon0[i] = view.getInt16(6 + n * 2 + i * 2, true);
    codes[i] = meta.codes[view.getUint16(6 + n * 4 + i * 2, true)];
    index.set(lat0[i] * 1000 + lon0[i], i);
  }
  return {
    ...meta,
    n,
    days,
    lat0,
    lon0,
    codes,
    index,
    highs: new Int8Array(buffer, header, n * days),
    dews: new Int8Array(buffer, header + n * days, n * days),
    clouds: new Uint8Array(buffer, header + 2 * n * days, n * days),
    counts: new Uint16Array(n),
  };
}

function countGrid(grid, { low, high, dew, cloud }) {
  const { n, days, highs, dews, clouds, counts } = grid;
  for (let i = 0, k = 0; i < n; i += 1) {
    let total = 0;
    for (let d = 0; d < days; d += 1, k += 1) {
      const h = highs[k];
      if (h >= low && h <= high && dews[k] <= dew && clouds[k] <= cloud && h !== -128 && dews[k] !== -128)
        total += 1;
    }
    counts[i] = total;
  }
}

function readFilters() {
  return {
    low: +fields.low.value,
    high: +fields.high.value,
    dew: +fields.dew.value,
    cloud: +fields.cloud.value,
    tax: +fields.tax.value < +fields.tax.max ? +fields.tax.value : null,
    crypto: fields.crypto.value,
    includeUnknown: fields.unknown.checked,
  };
}

function passesPolicy(policy, filters) {
  const { tax, crypto, includeUnknown } = filters;
  const rate = policy?.tax?.rate;
  const status = policy?.crypto?.status;
  const passesTax =
    tax === null || (rate == null ? includeUnknown : rate <= tax);
  const passesCrypto =
    crypto === "all" || (status == null ? includeUnknown : crypto === status);
  return passesTax && passesCrypto;
}

function comfortableDays(values, { low, high, dew, cloud }) {
  const [highs, dews, clouds] = values;
  let days = 0;
  for (let i = 0; i < highs.length; i += 1) {
    if (
      highs[i] >= low * 10 &&
      highs[i] <= high * 10 &&
      dews[i] <= dew * 10 &&
      clouds[i] <= cloud
    )
      days += 1;
  }
  return days;
}

function taxText(policy) {
  return policy?.tax ? numberFormat.format(policy.tax.rate) + "%" : noData;
}

function cryptoText(policy) {
  return cryptoLabels[policy?.crypto?.status] ?? noData;
}

function sourceLink(label, url) {
  const link = node("a", label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function scaleLegend(ticks, style) {
  const group = node("div", undefined, "legend-scale");
  const labels = node("div", undefined, "ticks");
  labels.append(...ticks.map((x) => node("span", x)));
  group.append(
    node("div", undefined, "gradient" + (style ? " " + style : "")),
    labels,
  );
  return group;
}

function weatherLegend() {
  // Ticks sit at their true position on the gradient, which is not linear.
  const group = node("div", undefined, "legend-scale");
  const labels = node("div", undefined, "ticks positioned");
  const max = weatherTicks.at(-1);
  labels.append(
    ...weatherTicks.map((days, i) => {
      const tick = node(
        "span",
        i === weatherTicks.length - 1 ? days + "+" : String(days),
      );
      tick.style.left = (days / max) * 100 + "%";
      return tick;
    }),
  );
  group.append(node("div", undefined, "gradient"), labels);
  return group;
}

function swatch(label, color) {
  const item = node("span", undefined, "legend-item");
  const chip = node("i", undefined, "chip");
  if (color) chip.style.setProperty("--chip", color);
  item.append(chip, node("span", label));
  return item;
}

function drawLegend() {
  const legend = el("legend");
  if (layer === "weather") {
    legend.replaceChildren(
      weatherLegend(),
      node("span", "comfortable days"),
      Object.assign(swatch("City sample (ERA5)", "#fff"), {
        className: "legend-item dot",
      }),
    );
  } else if (layer === "tax") {
    legend.replaceChildren(
      scaleLegend(["0%", "15%", "30%", "45%", "60%+"], "tax"),
      swatch("No data"),
    );
  } else {
    legend.replaceChildren(
      ...Object.entries(cryptoLabels).map(([key, text]) =>
        swatch(text, cryptoColors[key]),
      ),
      swatch("No data"),
    );
  }
}

async function start() {
  const [boundaries, cityList, weather, policy, regions] = await Promise.all(
    ["boundaries", "locations", "weather", "policy", "regions"].map(getData),
  );
  const cities = cityList.filter((city) => weather.days[city.id]);
  const byCountry = d3.group(cities, (city) => city.code);
  const countryName = (code) =>
    regions[code] ?? (code.length === 2 ? regionNames.of(code) : code);
  const entries = new Map(
    Object.entries(regions).map(([code, name]) => [
      code,
      { code, name, country: true },
    ]),
  );
  const countryFeatures = boundaries.features.filter(
    (f) => f.properties.code !== "AQ",
  );
  for (const { properties } of countryFeatures) {
    const { code, name } = properties;
    if (!entries.has(code)) entries.set(code, { code, name, country: true });
  }
  const svg = d3.select("#world");
  const projection = d3
    .geoNaturalEarth1()
    .scale(174)
    .translate([500, 251])
    .precision(0.15);
  const path = d3.geoPath(projection);
  const camera = svg.append("g");
  camera
    .append("path")
    .datum(d3.geoGraticule10())
    .attr("class", "graticule")
    .attr("d", path);
  // The weather grid is painted on a canvas and shown as an image under the
  // country outlines. It is redrawn at screen resolution after each zoom.
  const surface = camera
    .append("image")
    .attr("class", "surface")
    .attr("preserveAspectRatio", "none")
    .attr("display", "none");
  let grid = null;
  let corners = null;
  let surfaceUrl = null;
  let surfaceFrame = 0;
  let activeCell = null;
  const countries = camera
    .append("g")
    .selectAll("path")
    .data(countryFeatures)
    .join("path")
    .attr("class", "country")
    .attr("d", path);
  const mappedCodes = new Set(countryFeatures.map((f) => f.properties.code));
  const islands = camera
    .append("g")
    .selectAll("circle")
    .data(
      [...byCountry.values()]
        .filter(([city]) => !mappedCodes.has(city.code))
        .map(([city]) => city),
    )
    .join("circle")
    .attr("class", "place")
    .attr("r", 5)
    .attr("cx", (city) => projection([city.lon, city.lat])[0])
    .attr("cy", (city) => projection([city.lon, city.lat])[1]);
  const points = camera
    .append("g")
    .selectAll("circle")
    .data(cities)
    .join("circle")
    .attr("class", "place")
    .attr("r", 2.8)
    .attr("cx", (city) => projection([city.lon, city.lat])[0])
    .attr("cy", (city) => projection([city.lon, city.lat])[1]);
  const sums = new Map();
  const gridSums = new Map();
  const cityCounts = new Map();
  const zoom = d3
    .zoom()
    .scaleExtent([1, 12])
    .translateExtent([
      [-100, -100],
      [1100, 610],
    ])
    .filter(
      (event) =>
        (!event.ctrlKey || event.type === "wheel") &&
        !event.button &&
        (event.type !== "wheel" || event.ctrlKey),
    )
    .on("zoom", (event) => {
      camera.attr("transform", event.transform);
      // Dots grow on screen up to 2× as the map zooms in.
      const { k } = event.transform;
      points.attr("r", (2.8 * Math.min(2, Math.sqrt(k))) / k);
      islands.attr("r", 5 / event.transform.k);
      el("tooltip").hidden = true;
    })
    .on("end", () => drawSurface());
  svg.call(zoom).on("dblclick.zoom", null);
  el("zoom-in").onclick = () =>
    svg.transition().duration(160).call(zoom.scaleBy, 1.6);
  el("zoom-out").onclick = () =>
    svg
      .transition()
      .duration(160)
      .call(zoom.scaleBy, 1 / 1.6);
  el("zoom-reset").onclick = () =>
    svg.transition().duration(160).call(zoom.transform, d3.zoomIdentity);

  function drawSurface() {
    if (!grid || layer !== "weather") return;
    cancelAnimationFrame(surfaceFrame);
    surfaceFrame = requestAnimationFrame(paintSurface);
  }

  function paintSurface() {
    const t = d3.zoomTransform(svg.node());
    const box = svg.node().getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(box.width * ratio));
    canvas.height = Math.max(1, Math.round((box.width * ratio * 510) / 1000));
    // Visible part of the map in un-zoomed SVG units.
    const x0 = -t.x / t.k;
    const y0 = -t.y / t.k;
    const w = 1000 / t.k;
    const h = 510 / t.k;
    const s = canvas.width / w;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.2 / s; // Overdraw hides seams between neighbouring cells.
    const filters = readFilters();
    const passing = new Map();
    for (let i = 0; i < grid.n; i += 1) {
      const c = corners.subarray(i * 8, i * 8 + 8);
      const minX = Math.min(c[0], c[2], c[4], c[6]);
      const maxX = Math.max(c[0], c[2], c[4], c[6]);
      const minY = Math.min(c[1], c[3], c[5], c[7]);
      const maxY = Math.max(c[1], c[3], c[5], c[7]);
      if (maxX < x0 || minX > x0 + w || maxY < y0 || minY > y0 + h) continue;
      if (maxX - minX > 500) continue; // Cell split by the antimeridian.
      const code = grid.codes[i];
      if (!passing.has(code))
        passing.set(code, passesPolicy(policy[code], filters));
      ctx.globalAlpha = passing.get(code) ? 1 : 0.2;
      ctx.fillStyle = ctx.strokeStyle = weatherColor(grid.counts[i]);
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(c[2], c[3]);
      ctx.lineTo(c[4], c[5]);
      ctx.lineTo(c[6], c[7]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Keep only the land.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    d3.geoPath(projection, ctx)({ type: "FeatureCollection", features: countryFeatures });
    ctx.fillStyle = "#000";
    ctx.fill();
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      surface
        .attr("href", url)
        .attr("x", x0)
        .attr("y", y0)
        .attr("width", w)
        .attr("height", h)
        .attr("display", layer === "weather" ? null : "none");
      if (surfaceUrl) URL.revokeObjectURL(surfaceUrl);
      surfaceUrl = url;
    });
  }

  function cellAt(event) {
    if (!grid) return null;
    const [lon, lat] = projection.invert(d3.pointer(event, camera.node())) ?? [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const i = grid.index.get(Math.floor(lat) * 1000 + Math.floor(lon));
    return i === undefined ? null : { i, lat, lon };
  }

  function cellLabel({ lat, lon }) {
    const fmt = (v, pos, neg) =>
      Math.abs(Math.floor(v) + 0.5).toFixed(1) + "°" + (v >= 0 ? pos : neg);
    return fmt(lat, "N", "S") + ", " + fmt(lon, "E", "W");
  }

  function classifyColor(code, days) {
    if (layer === "weather")
      return days == null ? noDataColor : weatherColor(days);
    if (layer === "tax")
      return policy[code]?.tax ? taxColor(policy[code].tax.rate) : noDataColor;
    return cryptoColors[policy[code]?.crypto?.status] ?? noDataColor;
  }

  function hover(event, title, text) {
    const tooltip = el("tooltip");
    const bounds = el("map").getBoundingClientRect();
    tooltip.replaceChildren(node("strong", title), node("div", text));
    tooltip.hidden = false;
    tooltip.style.left =
      Math.max(
        4,
        Math.min(
          event.clientX - bounds.left + 10,
          bounds.width - tooltip.offsetWidth - 4,
        ),
      ) + "px";
    tooltip.style.top =
      Math.max(
        4,
        Math.min(
          event.clientY - bounds.top + 10,
          bounds.height - tooltip.offsetHeight - 4,
        ),
      ) + "px";
  }

  function hoverText(code, days) {
    if (layer === "tax") return "Top income tax · " + taxText(policy[code]);
    if (layer === "crypto") return cryptoText(policy[code]);
    return days == null
      ? "Weather sample unavailable"
      : numberFormat.format(days) + " comfortable days";
  }

  function select(entry, center = false, cell = null) {
    active = entry;
    activeCell = cell;
    if (center) {
      const reference = entry.country ? byCountry.get(entry.code)?.[0] : entry;
      const outline = countryFeatures.find(
        (f) => f.properties.code === entry.code,
      );
      const target = reference
        ? projection([reference.lon, reference.lat])
        : outline
          ? path.centroid(outline)
          : null;
      if (target?.every(Number.isFinite)) {
        const scale = entry.country ? 2.2 : 3.3;
        svg
          .transition()
          .duration(230)
          .call(
            zoom.transform,
            d3.zoomIdentity
              .translate(500 - target[0] * scale, 255 - target[1] * scale)
              .scale(scale),
          );
      }
    }
    drawSelection();
  }

  function drawSelection() {
    countries.classed("selected", (f) => active?.code === f.properties.code);
    points.classed("selected", (city) => active?.id === city.id);
    islands.classed("selected", (city) => active?.code === city.code);
    if (!active) {
      selection.replaceChildren(
        node(
          "p",
          "Select a city or country to see its weather and policy data.",
        ),
      );
      return;
    }
    const { code, name, id, country } = active;
    const metric = country ? sums.get(code) : cityCounts.get(id);
    const values = policy[code];
    const stats = node("ul");
    const samples = byCountry.get(code)?.length ?? 0;
    const fromGrid = country && gridSums.has(code);
    const weatherText =
      metric == null
        ? "Weather sample unavailable"
        : numberFormat.format(metric) +
          " comfortable days" +
          (fromGrid
            ? " · land-area average"
            : country
              ? " · " +
                samples +
                (samples === 1 ? " sampled location" : " sampled locations")
              : " · city sample");
    stats.append(node("li", weatherText));
    if (country && activeCell && grid?.codes[activeCell.i] === code)
      stats.append(
        node(
          "li",
          numberFormat.format(grid.counts[activeCell.i]) +
            " comfortable days at " +
            cellLabel(activeCell),
        ),
      );
    const tax = node("li", "Top income tax · " + taxText(values));
    if (values?.tax)
      tax.append(
        " ",
        sourceLink(values.tax.date ?? values.tax.provider, values.tax.url),
      );
    const crypto = node("li", "Crypto · " + cryptoText(values));
    if (values?.crypto)
      crypto.append(" ", sourceLink("FATF", policySources.fatf));
    stats.append(tax, crypto);
    selection.replaceChildren(
      node("strong", country ? name : name + ", " + countryName(code)),
      stats,
    );
  }

  const tooltipOff = () => {
    el("tooltip").hidden = true;
  };
  countries
    .on("pointermove", (event, f) => {
      const { code } = f.properties;
      const cell = layer === "weather" ? cellAt(event) : null;
      if (cell)
        hover(
          event,
          countryName(code),
          numberFormat.format(grid.counts[cell.i]) +
            " comfortable days · " +
            cellLabel(cell),
        );
      else hover(event, countryName(code), hoverText(code, sums.get(code)));
    })
    .on("pointerleave", tooltipOff)
    .on("click", (event, f) =>
      select(
        entries.get(f.properties.code),
        false,
        layer === "weather" ? cellAt(event) : null,
      ),
    );
  points
    .on("pointermove", (event, city) =>
      hover(event, city.name, hoverText(city.code, cityCounts.get(city.id))),
    )
    .on("pointerleave", tooltipOff)
    .on("click", (_, city) => select(city));
  islands
    .on("pointermove", (event, city) =>
      hover(event, countryName(city.code), hoverText(city.code)),
    )
    .on("pointerleave", tooltipOff)
    .on("click", (_, city) => select(entries.get(city.code)));

  function drawResults(filters) {
    const matches = cities
      .filter((city) => passesPolicy(policy[city.code], filters))
      .sort(
        (a, b) =>
          cityCounts.get(b.id) - cityCounts.get(a.id) ||
          a.name.localeCompare(b.name),
      );
    const displayed = matches.slice(0, 15);
    el("result-count").textContent = matches.length
      ? "Showing " +
        displayed.length +
        " of " +
        matches.length +
        " sampled locations"
      : "No sampled locations match these filters";
    const body = el("results");
    body.replaceChildren();
    for (const city of displayed) {
      const row = node("tr");
      const location = node("td");
      const button = node("button", city.name, "result-link");
      button.type = "button";
      button.onclick = () => {
        select(city, true);
        el("map-title").scrollIntoView({ block: "nearest" });
      };
      location.append(
        button,
        node("span", countryName(city.code), "result-country"),
      );
      row.append(
        location,
        node("td", cityCounts.get(city.id)),
        node("td", taxText(policy[city.code])),
        node("td", cryptoText(policy[city.code])),
      );
      body.append(row);
    }
  }

  function render() {
    const filters = readFilters();
    for (const id of ["low", "high", "dew"])
      el(id + "-value").textContent = filters[id] + "°F";
    el("cloud-value").textContent = "≤ " + filters.cloud + "%";
    el("tax-value").textContent =
      filters.tax == null ? "Any rate" : "≤ " + filters.tax + "%";
    for (const city of cities)
      cityCounts.set(city.id, comfortableDays(weather.days[city.id], filters));
    for (const [code, group] of byCountry)
      sums.set(
        code,
        d3.mean(group, (city) => cityCounts.get(city.id)),
      );
    if (grid) {
      countGrid(grid, filters);
      // Country value = land-area weighted mean of its grid cells.
      const totals = new Map();
      for (let i = 0; i < grid.n; i += 1) {
        const weight = Math.cos(((grid.lat0[i] + 0.5) * Math.PI) / 180);
        const t = totals.get(grid.codes[i]) ?? [0, 0];
        t[0] += grid.counts[i] * weight;
        t[1] += weight;
        totals.set(grid.codes[i], t);
      }
      for (const [code, [sum, weight]] of totals) {
        gridSums.set(code, sum / weight);
        sums.set(code, sum / weight);
      }
      drawSurface();
    }
    countries
      .attr("fill", (f) =>
        grid && layer === "weather"
          ? "transparent"
          : classifyColor(f.properties.code, sums.get(f.properties.code)),
      )
      .classed("dim", (f) => !passesPolicy(policy[f.properties.code], filters));
    points
      .attr("display", layer === "weather" ? null : "none")
      .attr("fill", (city) => weatherColor(cityCounts.get(city.id)))
      .classed("dim", (city) => !passesPolicy(policy[city.code], filters));
    islands
      .attr("display", layer === "weather" ? "none" : null)
      .attr("fill", (city) => classifyColor(city.code))
      .classed("dim", (city) => !passesPolicy(policy[city.code], filters));
    drawResults(filters);
    drawSelection();
  }

  const policySources = {
    fatf: "https://www.fatf-gafi.org/en/publications/Fatfrecommendations/targeted-updated-virtualassets-vasps-2026.html",
  };
  const sampleSummary =
    cities.length +
    " locations · " +
    weather.year +
    " ERA5 · country fill averages sampled locations";
  const subtitles = {
    weather: sampleSummary,
    tax: "Top statutory personal income tax rate · OECD and supplemental territory summaries",
    crypto: "Virtual asset service provider rules · FATF snapshot, July 2026",
  };
  const titles = {
    weather: "Comfortable days per year",
    tax: "Personal income tax",
    crypto: "Crypto regulation",
  };
  el("weather-method").textContent =
    "The colored surface is a 1° land grid (about 110 km north to south) of " +
    weather.year +
    " daily NASA POWER data: MERRA-2 daily maximum temperature and daily mean dew point, and CERES daily mean cloud amount. Each cell averages the MERRA-2 points over its land. A day counts only when the maximum temperature is within the selected range, the dew point is at or below the cap, and cloud cover is at or below the cap. The grid uses mean rather than maximum dew point, so it is slightly more forgiving on humidity than the city samples. Country values are land-area averages of their cells. The " +
    cities.length +
    " outlined dots are city samples from daily Copernicus ERA5 reanalysis via Open-Meteo, using maximum dew point and each city’s local time zone. The two sources can disagree, especially on coastal cloud. Both are one-year snapshots, and a 1° cell can miss local variation in terrain and climate.";

  function setLayer(next) {
    layer = next;
    for (const button of document.querySelectorAll("[data-layer]"))
      button.setAttribute("aria-pressed", button.dataset.layer === layer);
    el("map-title").textContent = titles[layer];
    el("map-subtitle").textContent = subtitles[layer];
    surface.attr("display", layer === "weather" && grid ? null : "none");
    drawLegend();
    render();
  }

  for (const field of Object.values(fields)) {
    field.addEventListener("input", () => {
      if (+fields.low.value > +fields.high.value) {
        if (field === fields.low) fields.high.value = fields.low.value;
        else fields.low.value = fields.high.value;
      }
      render();
    });
  }
  for (const button of document.querySelectorAll("[data-layer]"))
    button.onclick = () => setLayer(button.dataset.layer);
  el("reset").onclick = () => {
    for (const id of ["low", "high", "dew", "cloud", "tax"])
      fields[id].value = fields[id].defaultValue;
    fields.crypto.value = "all";
    fields.unknown.checked = false;
    render();
  };

  const search = el("search");
  const suggestions = el("search-results");
  const searchable = [...cities, ...entries.values()];
  const normalize = (value) =>
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .trim();
  for (const entry of searchable) {
    entry.searchName = normalize(entry.name);
    entry.searchText =
      entry.searchName + " " + normalize(countryName(entry.code));
  }
  function setSuggestions(open) {
    suggestions.hidden = !open;
  }
  function searchForMatches() {
    const query = normalize(search.value);
    suggestions.replaceChildren();
    if (query.length < 2) return setSuggestions(false);
    const found = searchable
      .filter((entry) => entry.searchText.includes(query))
      .sort(
        (a, b) =>
          (b.searchName === query) - (a.searchName === query) ||
          b.searchName.startsWith(query) - a.searchName.startsWith(query) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 7);
    for (const entry of found) {
      const item = node("li");
      const button = node(
        "button",
        entry.country
          ? entry.name + " · Jurisdiction"
          : entry.name + " · " + countryName(entry.code),
      );
      button.type = "button";
      button.onclick = () => {
        search.value = entry.name;
        select(
          entry,
          !entry.country ||
            countryFeatures.some((f) => f.properties.code === entry.code) ||
            byCountry.has(entry.code),
        );
        search.focus();
        setSuggestions(false);
      };
      item.append(button);
      suggestions.append(item);
    }
    if (!found.length)
      suggestions.append(node("li", "No locations found", "empty-search"));
    setSuggestions(true);
  }
  search.addEventListener("input", searchForMatches);
  search.addEventListener("keydown", (event) => {
    const first = suggestions.querySelector("button");
    if (event.key === "Escape") setSuggestions(false);
    if (
      !suggestions.hidden &&
      first &&
      (event.key === "Enter" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      if (event.key === "Enter") first.click();
      else first.focus();
    }
  });
  document.addEventListener("focusin", (event) => {
    if (!event.target.closest(".search")) setSuggestions(false);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search")) setSuggestions(false);
  });
  document.querySelector('a[href="#methodology"]').onclick = () => {
    el("methodology").open = true;
  };
  setLayer("weather");

  try {
    grid = await getGrid();
  } catch (error) {
    console.error(error);
    return;
  }
  corners = new Float32Array(grid.n * 8);
  for (let i = 0; i < grid.n; i += 1) {
    const x = grid.lon0[i];
    const y = grid.lat0[i];
    [
      [x, y],
      [x + 1, y],
      [x + 1, y + 1],
      [x, y + 1],
    ].forEach((corner, j) => corners.set(projection(corner), i * 8 + j * 2));
  }
  subtitles.weather =
    "1° land grid · NASA POWER " +
    grid.year +
    " · dots are " +
    cities.length +
    " ERA5 city samples";
  el("map-subtitle").textContent = subtitles[layer];
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawSurface, 150);
  });
  render();
}

start().catch((error) => {
  console.error(error);
  el("map-subtitle").textContent =
    "Map data could not load. Refresh this page to try again.";
});
