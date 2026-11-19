# Comfort Atlas

An interactive world map for comparing historical weather, top personal income tax rates, and virtual asset service provider rules.

## Run locally

With Node.js 20 or later:

```sh
node scripts/build.mjs
python3 -m http.server 8000 --directory public
```

Open http://localhost:8000. The build produces a static site and requires no package installation, runtime network access, or API keys.

## Vercel

Import the repository in Vercel and choose the project directory. Vercel reads the static build settings from `vercel.json`. For a linked Vercel project, run `vercel deploy --prod` from the project directory.

## Data

- **Weather** uses 2025 Copernicus ERA5 daily reanalysis from [Open-Meteo](https://open-meteo.com/en/docs/historical-weather-api) under CC BY 4.0. The archive request uses `models=era5`, `cell_selection=land`, the location's local time zone, and daily `temperature_2m_max,dew_point_2m_max,cloud_cover_mean`. In `weather.json`, each location ID maps to three 365-day arrays, ordered from January 1 through December 31. The two temperature series are stored as tenths of a degree Fahrenheit. Cloud cover is in percent. The displayed total counts days satisfying all three thresholds. Country fill averages the sampled locations equally. Small islands and mountainous terrain may be poorly resolved by ERA5. This is a 2025 snapshot.
- **Places** come from [Natural Earth](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/), [GeoNames](https://www.geonames.org/) (CC BY 4.0), and selected sample coordinates. Natural Earth supplies the world boundaries.
- **Tax** uses the [OECD](https://data-explorer.oecd.org/vis?df%5Bag%5D=OECD.CTP.TPS&df%5Bid%5D=DSD_TAX_PIT%40DF_PIT_TOP_EARN_THRESH&df%5Bvs%5D=1.0) 2025 `TS_PIT` series and selected [PwC Worldwide Tax Summaries](https://taxsummaries.pwc.com/quick-charts/personal-income-tax-pit-rates). Supplemental rates can reflect national rates only. Each displayed rate links to its source. Effective tax, special regimes, investment gains, and tax residency rules require separate analysis.
- **Crypto** uses Annex A of the [FATF seventh targeted update](https://www.fatf-gafi.org/en/publications/Fatfrecommendations/targeted-updated-virtualassets-vasps-2026.html), published in July 2026. The map uses the explicit prohibition column first and the enacted service-provider licensing or registration column second. The categories describe the published snapshot. They do not assess trading platforms, taxation, personal holdings, or product availability.
- **Visualization** uses D3. See the included license in `vendor/`.

A jurisdiction absent from a policy source remains unavailable. With a policy filter active, the default excludes unavailable entries from the results and dims them on the map. The user can include them with the checkbox.
