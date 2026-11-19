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
const weatherColors = [
  "#e8d7ef",
  "#9cadd3",
  "#62b8cf",
  "#8ac997",
  "#f8d16b",
  "#ed934c",
  "#bb453a",
];
const weatherColor = d3
  .scaleLinear(
    weatherColors.map((_, i) => (i * 365) / 6),
    weatherColors,
  )
  .clamp(true);
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
      scaleLegend(["0", "90", "180", "270", "365 days"]),
      swatch("No sample"),
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
    .attr("r", 3.8)
    .attr("cx", (city) => projection([city.lon, city.lat])[0])
    .attr("cy", (city) => projection([city.lon, city.lat])[1]);
  const sums = new Map();
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
      points.attr("r", 3.8 / event.transform.k);
      islands.attr("r", 5 / event.transform.k);
      el("tooltip").hidden = true;
    });
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

  function select(entry, center = false) {
    active = entry;
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
    const weatherText =
      metric == null
        ? "Weather sample unavailable"
        : numberFormat.format(metric) +
          " comfortable days" +
          (country
            ? " · " +
              samples +
              (samples === 1 ? " sampled location" : " sampled locations")
            : "");
    stats.append(node("li", weatherText));
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
      hover(event, countryName(code), hoverText(code, sums.get(code)));
    })
    .on("pointerleave", tooltipOff)
    .on("click", (_, f) => select(entries.get(f.properties.code)));
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
    countries
      .attr("fill", (f) =>
        classifyColor(f.properties.code, sums.get(f.properties.code)),
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
    "Weather uses daily Copernicus ERA5 reanalysis via Open-Meteo for " +
    weather.year +
    ". A day counts only when its maximum temperature is within the selected range, its maximum dew point is at or below the cap, and its mean cloud cover is at or below the cap. Days use each location’s local time zone. Country colors average the " +
    cities.length +
    " sampled locations where available. This is a one-year snapshot, and samples can miss local variation in terrain and climate.";

  function setLayer(next) {
    layer = next;
    for (const button of document.querySelectorAll("[data-layer]"))
      button.setAttribute("aria-pressed", button.dataset.layer === layer);
    el("map-title").textContent = titles[layer];
    el("map-subtitle").textContent = subtitles[layer];
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
}

start().catch((error) => {
  console.error(error);
  el("map-subtitle").textContent =
    "Map data could not load. Refresh this page to try again.";
});
