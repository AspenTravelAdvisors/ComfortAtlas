import { cp, mkdir, rm } from "node:fs/promises";

const out = new URL("../public/", import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ["index.html", "styles.css", "atlas.js", "data", "vendor"]) {
  await cp(new URL("../" + file, import.meta.url), new URL(file, out), {
    recursive: true,
  });
}
