#!/usr/bin/env node
// Builds test-results/ui/compare.html: every state captured by e2e/layout.spec.ts, side by side
// with a reference image of the same name (e.g. `04-approval.png`) from a directory you pass,
// plus an overlay with an opacity slider for pixel-level review. Reference images are kept out
// of the repository; point this at wherever they live.
//
//   npm run ui:capture                 # writes test-results/ui/*.png + manifest.json
//   npm run ui:compare -- ~/refs/codex # writes test-results/ui/compare.html
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(appDir, "test-results", "ui");
const manifestPath = path.join(uiDir, "manifest.json");
const refDir = process.argv[2] ? path.resolve(process.argv[2]) : process.env.MODEX_UI_REFERENCE ? path.resolve(process.env.MODEX_UI_REFERENCE) : null;

if (!fs.existsSync(manifestPath)) {
  console.error(`No captures at ${uiDir}. Run \`npm run ui:capture\` first.`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const rows = manifest.states.map(({ state, file, viewport }) => {
  const shot = pathToFileURL(path.join(uiDir, file)).href;
  const refFile = refDir ? path.join(refDir, `${state}.png`) : null;
  const ref = refFile && fs.existsSync(refFile) ? pathToFileURL(refFile).href : null;
  return `<section>
  <h2>${esc(state)} <small>${viewport.width}×${viewport.height}${ref ? "" : " · no reference"}</small></h2>
  <div class="pair">
    <figure><figcaption>Modex</figcaption><img src="${shot}" alt="Modex ${esc(state)}"></figure>
    ${ref ? `<figure><figcaption>Reference</figcaption><img src="${ref}" alt="Reference ${esc(state)}"></figure>
    <figure><figcaption>Overlay <input type="range" min="0" max="100" value="50" aria-label="Reference opacity"></figcaption>
      <div class="overlay"><img src="${shot}" alt=""><img class="top" src="${ref}" alt="" style="opacity:.5"></div></figure>` : ""}
  </div>
</section>`;
});

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Modex UI compare</title>
<style>
  body { background:#0b0b0c; color:#ddd; font:13px/1.5 -apple-system, sans-serif; margin:24px; }
  h1 { font-size:18px; } h2 { font-size:14px; margin:28px 0 8px; } small { color:#888; font-weight:400; }
  .pair { display:grid; grid-template-columns:repeat(auto-fit, minmax(420px, 1fr)); gap:12px; }
  figure { margin:0; } figcaption { color:#999; margin-bottom:4px; display:flex; gap:8px; align-items:center; }
  img { width:100%; display:block; border:1px solid #2a2a2b; image-rendering:pixelated; }
  .overlay { position:relative; } .overlay .top { position:absolute; inset:0; }
</style></head><body>
<h1>Modex UI compare <small>reference: ${esc(refDir ?? "none — pass a directory of <state>.png files")}</small></h1>
${rows.join("\n")}
<script>
  for (const f of document.querySelectorAll("figure")) {
    const r = f.querySelector("input[type=range]"); const top = f.querySelector(".top");
    if (r && top) r.addEventListener("input", () => { top.style.opacity = r.value / 100; });
  }
</script>
</body></html>
`;
const out = path.join(uiDir, "compare.html");
fs.writeFileSync(out, html);
console.log(out);
