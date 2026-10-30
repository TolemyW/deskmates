// UI fingerprint: a regression oracle for changes that must not move a pixel (CSS moves,
// framework refactors). `capture` builds the standalone demo (demo.html on the in-browser
// MockGateway), visits every screen at three viewports in the light and the dark theme, and
// records per element a stable DOM path, tag, own text, attributes, box, the full computed
// style and the computed style of its ::before/::after, plus a full-page screenshot. `compare`
// prints every differing state, element, property and text and the number of differing pixels,
// and exits non-zero on any difference.
//
//   node packages/web/scripts/ui-fingerprint.mjs capture <outDir> [--no-build] [--dist <dir>] [--jobs N] [--only <regex>]
//   node packages/web/scripts/ui-fingerprint.mjs compare <dirA> <dirB> [--limit N] [--pixel-tolerance N]
//
// Environment: PLAYWRIGHT_MODULE (a path to a `playwright` package when none resolves from this
// repository), PLAYWRIGHT_CHROMIUM (a Chromium executable; otherwise Playwright's own, else the
// newest headless shell in the Playwright browser cache). Usage notes: scripts/README.md.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webDir, "../..");

/** Fixed wall clock for every page: relative times ("3 min ago") never move. */
const FIXED_TIME = "2026-10-01T09:00:00.000Z";
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 768 },
  { name: "390", width: 390, height: 844 },
];
const THEMES = ["light", "dark"];
const FORMAT = 1;
/**
 * Rendering flags for repeatable pixels: software raster on one thread, fixed colour profile, no
 * LCD text. Without the GPU flags the curved corners of a box at a fractional offset came out
 * a few pixels different from one page load to the next.
 *
 * Tailwind scans this directory for class candidates: a new word here that names a utility
 * (say, a box-corner or font-smoothing one) adds a rule to the built stylesheet. Check the
 * built `demo.css` of a capture against a capture without the change when editing comments.
 */
const CHROMIUM_ARGS = [
  "--force-color-profile=srgb",
  "--disable-lcd-text",
  "--font-render-hinting=none",
  "--num-raster-threads=1",
  "--disable-skia-runtime-opts",
  "--disable-gpu",
  "--disable-gpu-compositing",
  "--disable-partial-raster",
];

// ---------- shared helpers ----------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"];
  candidates.push(join(repoRoot, "spikes/s0/node_modules/playwright"));
  // A git worktree has no spike dependencies of its own; use the main checkout's.
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (common.status === 0) {
    candidates.push(join(dirname(common.stdout.trim()), "spikes/s0/node_modules/playwright"));
  }
  for (const candidate of candidates.filter(Boolean)) {
    try {
      return require(candidate);
    } catch {
      // try the next one
    }
  }
  throw new Error("no `playwright` package found; set PLAYWRIGHT_MODULE");
}

async function launchChromium(chromium) {
  if (process.env.PLAYWRIGHT_CHROMIUM) {
    return chromium.launch({
      args: CHROMIUM_ARGS,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM,
    });
  }
  try {
    return await chromium.launch({ args: CHROMIUM_ARGS });
  } catch (error) {
    // Playwright's pinned build is not downloaded; use the newest cached headless shell.
    const cache = join(homedir(), "Library/Caches/ms-playwright");
    const fallbacks = existsSync(cache)
      ? readdirSync(cache)
          .filter((name) => name.startsWith("chromium_headless_shell-"))
          .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
      : [];
    for (const dir of fallbacks) {
      for (const sub of readdirSync(join(cache, dir))) {
        const bin = join(cache, dir, sub, "chrome-headless-shell");
        if (existsSync(bin)) return chromium.launch({ args: CHROMIUM_ARGS, executablePath: bin });
      }
    }
    throw error;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};

function serve(root) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

// ---------- in-page code (runs in the browser) ----------

/** Waits until the DOM stops changing, images are loaded and fonts are ready. */
async function settlePage() {
  await document.fonts.ready;
  const sample = () => {
    const html = document.documentElement.outerHTML;
    let hash = 0;
    for (let i = 0; i < html.length; i += 1) hash = (hash * 31 + html.charCodeAt(i)) | 0;
    return `${html.length}:${hash}`;
  };
  let last = "";
  let stable = 0;
  // Date.now() is pinned by the fixed clock; count polls instead of reading the clock.
  for (let polls = 0; polls < 60 && stable < 4; polls += 1) {
    await new Promise((done) => setTimeout(done, 250));
    const now = sample();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  // Loaded is not enough for a screenshot: wait until every image is decoded too.
  await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
  await document.fonts.ready;
  // Finished transitions and animations leave their end state; infinite ones stop at 0.
  for (const animation of document.getAnimations()) {
    try {
      animation.finish();
    } catch {
      animation.pause();
      animation.currentTime = 0;
    }
  }
  return stable >= 4;
}

/**
 * Settles what a busy load can leave behind. A scroll container whose content was taller for a
 * moment keeps its classic scroll bar (15px of layout) after the content shrinks; giving every
 * scroll container `overflow: hidden` for one layout and restoring it makes Chromium decide the
 * scrollbars again from the final content. Hiding and showing the page then repaints every
 * layer, so no raster made while the page was still changing reaches the screenshot. Inline
 * styles and scroll offsets are restored exactly.
 */
async function freshLayout() {
  const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
  const scrollers = [...document.querySelectorAll("*")].filter((el) => {
    const style = getComputedStyle(el);
    return /auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflowX);
  });
  const saved = scrollers.map((el) => [el, el.getAttribute("style"), el.scrollTop, el.scrollLeft]);
  for (const [el] of saved) el.style.setProperty("overflow", "hidden", "important");
  void document.documentElement.offsetHeight;
  for (const [el, style, top, left] of saved) {
    if (style === null) el.removeAttribute("style");
    else el.setAttribute("style", style);
    void el.offsetHeight;
    el.scrollTop = top;
    el.scrollLeft = left;
  }
  const hide = new CSSStyleSheet();
  hide.replaceSync("html { visibility: hidden !important; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, hide];
  await frame();
  await frame();
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== hide);
  await frame();
  await frame();
}

/** Records every element under <html> except <head>. Styles are stored as a diff to defaults. */
function recordPage() {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
  document.documentElement.appendChild(frame);
  const blank = frame.contentDocument;
  const defaults = {};
  const defaultFor = (el) => {
    const key = `${el.namespaceURI}|${el.localName}`;
    if (!defaults[key]) {
      const probe = blank.createElementNS(el.namespaceURI, el.localName);
      const host =
        el.namespaceURI === "http://www.w3.org/2000/svg" && el.localName !== "svg"
          ? blank.body.appendChild(blank.createElementNS("http://www.w3.org/2000/svg", "svg"))
          : blank.body;
      host.appendChild(probe);
      const style = blank.defaultView.getComputedStyle(probe);
      const values = {};
      for (let i = 0; i < style.length; i += 1) {
        const prop = style[i];
        values[prop] = style.getPropertyValue(prop);
      }
      defaults[key] = values;
    }
    return { key, values: defaults[key] };
  };
  const diffStyle = (style, base) => {
    const out = {};
    for (let i = 0; i < style.length; i += 1) {
      const prop = style[i];
      const value = normalise(style.getPropertyValue(prop));
      if (base[prop] !== value) out[prop] = value;
    }
    // A property the default has but this style lacks is recorded as absent.
    for (const prop of Object.keys(base)) {
      if (!(prop in out) && style.getPropertyValue(prop) === "" && base[prop] !== "")
        out[prop] = "";
    }
    return out;
  };
  // Object URLs are random and the local server's port changes per capture.
  const normalise = (value) =>
    value
      .replace(/blob:[^\s"')]+/g, "blob:")
      .split(location.origin)
      .join("{origin}");
  const elements = [];
  const walk = (el, path) => {
    if (el === frame || el.localName === "head") return;
    const { key, values } = defaultFor(el);
    const style = getComputedStyle(el);
    const attrs = {};
    for (const attr of el.attributes) attrs[attr.name] = normalise(attr.value);
    let text = "";
    for (const node of el.childNodes) if (node.nodeType === 3) text += node.textContent;
    const rect = el.getBoundingClientRect();
    const entry = {
      path,
      tag: el.localName,
      d: key,
      text: normalise(text.replace(/\s+/g, " ").trim()),
      attrs,
      rect: [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 100) / 100),
      style: diffStyle(style, values),
    };
    if (el.scrollTop || el.scrollLeft) entry.scroll = [el.scrollTop, el.scrollLeft];
    if ("value" in el && typeof el.value === "string" && el.localName !== "button") {
      entry.value = normalise(el.value);
    }
    for (const pseudo of ["::before", "::after", "::marker", "::placeholder"]) {
      const ps = getComputedStyle(el, pseudo);
      const content = ps.getPropertyValue("content");
      const relevant =
        pseudo === "::placeholder"
          ? el.hasAttribute("placeholder")
          : pseudo === "::marker"
            ? // the list item display (spelled out it would be a Tailwind class name, see top)
              style.display.endsWith("item")
            : content !== "none" && content !== "normal";
      if (relevant) {
        entry.pseudo ??= {};
        entry.pseudo[pseudo] = diffStyle(ps, defaultFor(document.createElement("div")).values);
      }
    }
    elements.push(entry);
    const counts = {};
    for (const child of el.children) {
      const name = child.localName;
      const index = counts[name] ?? 0;
      counts[name] = index + 1;
      walk(child, `${path}>${name}[${index}]`);
    }
  };
  walk(document.documentElement, "html");
  frame.remove();
  return {
    title: document.title,
    hash: location.hash,
    scroll: [window.scrollX, window.scrollY],
    size: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    defaults,
    elements,
  };
}

// ---------- screens ----------

/** Visits one route and collects the in-app links of a kind, for the screens that need an id. */
async function discover(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  const links = async (route, prefix) => {
    await page.goto(`${base}/demo.html#/${route}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(settlePage);
    return page.$$eval(
      "a[href^='#/']",
      (anchors, p) => [
        ...new Set(anchors.map((a) => a.getAttribute("href")).filter((h) => h.startsWith(p))),
      ],
      `#/${prefix}/`,
    );
  };
  const threads = await links("threads", "threads");
  const runs = threads.length ? await links(threads[0].slice(2), "runs") : [];
  const contacts = (await links("contacts", "contacts")).filter((h) => h !== "#/contacts/new");
  const tasks = await links("tasks", "tasks");
  await context.close();
  return { threads, runs, contacts, tasks };
}

/**
 * Every screen: name, hash (and query) to open, optional interaction after it settles.
 * Interactions use roles and English labels, so the demo is captured in `en-US`.
 */
function screens(found) {
  const list = [
    { name: "home", hash: "#/" },
    { name: "threads", hash: "#/threads" },
    ...found.threads.map((hash, i) => ({ name: `thread-${i}`, hash })),
    { name: "run", hash: found.runs[0] ?? "#/runs/missing" },
    { name: "contacts", hash: "#/contacts" },
    { name: "contact", hash: found.contacts[0] ?? "#/contacts/missing" },
    ...["Experience", "Your notes", "Settings"].map((tab) => ({
      name: `contact-${tab.toLowerCase().replace(/\s+/g, "-")}`,
      hash: found.contacts[0] ?? "#/contacts/missing",
      action: async (page) => page.getByRole("button", { name: tab, exact: true }).first().click(),
    })),
    { name: "contacts-new", hash: "#/contacts/new" },
    { name: "channels", hash: "#/channels" },
    { name: "desktops", hash: "#/desktops" },
    { name: "tasks", hash: "#/tasks" },
    { name: "task", hash: found.tasks[0] ?? "#/tasks/missing" },
    { name: "approvals", hash: "#/approvals" },
    { name: "files", hash: "#/resources/files" },
    { name: "knowledge-documents", hash: "#/knowledge/documents" },
    { name: "knowledge-observations", hash: "#/knowledge/observations" },
    { name: "skills", hash: "#/skills" },
    { name: "computer", hash: "#/computer" },
    { name: "trash", hash: "#/trash" },
    { name: "costs", hash: "#/costs" },
    { name: "connections", hash: "#/connections/channels" },
    { name: "connections-apps", hash: "#/connections/apps" },
    { name: "members", hash: "#/members" },
    { name: "account", hash: "#/account" },
    {
      name: "workspace-switcher",
      hash: "#/threads",
      action: async (page) =>
        page
          .getByRole("button", { name: /^Workspace:/ })
          .first()
          .click(),
    },
    {
      name: "help",
      hash: "#/threads",
      action: async (page) => page.getByRole("button", { name: "Help", exact: true }).click(),
    },
    { name: "sign-in", hash: "#/threads", query: "?signedOut=1" },
    { name: "invite", hash: "#/invite/demo-signup", query: "?signedOut=1" },
  ];
  return list;
}

async function captureState(browser, base, viewport, theme, screen, outDir) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: theme,
    reducedMotion: "no-preference",
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem("deskmates.theme", value);
    // Seeded Math.random (mulberry32): React Aria's id prefix and the mock's latencies repeat.
    let seed = 0x9e3779b9;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // No transitions and no animation time while the page loads: an element that was moved or
    // scaled by a transition or a keyframe animation keeps a compositor layer for a while, and
    // a busy machine screenshots it with different edge pixels (or a drawer with a different
    // scroll bar gutter). Animations still start, with zero duration, so they end at once. The
    // sheet is removed before recording, so computed styles keep the real values; removing it
    // changes no animation name and so restarts nothing, and starts no transition.
    const quiet = new CSSStyleSheet();
    quiet.replaceSync(
      "*, *::before, *::after { transition: none !important;" +
        " animation-duration: 0s !important; animation-delay: 0s !important; }",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, quiet];
    window.__fingerprintQuiet = quiet;
    // Fixture shim: the demo's skills view (76bb036b) omits `starterSkills` and the Skills
    // screen throws. Fill the missing list so the screen and its styles are captured; a demo
    // that sends the field is passed through unchanged.
    let installed = window.fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      get: () => installed,
      set: (next) => {
        installed = async (input, init) => {
          const response = await next(input, init);
          const url = typeof input === "string" ? input : String(input.url ?? input);
          if (
            !/\/api\/workspaces\/[^/?]+\/skills(\?|$)/.test(url) ||
            (init?.method ?? "GET") !== "GET"
          ) {
            return response;
          }
          const body = await response.clone().json();
          if (body && !Array.isArray(body.starterSkills)) body.starterSkills = [];
          return new Response(JSON.stringify(body), {
            status: response.status,
            headers: response.headers,
          });
        };
      },
    });
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await page.goto(`${base}/demo.html${screen.query ?? ""}${screen.hash}`);
  await page.waitForLoadState("networkidle");
  let stable = await page.evaluate(settlePage);
  if (screen.action) {
    try {
      await screen.action(page);
      await page.waitForLoadState("networkidle");
      stable = (await page.evaluate(settlePage)) && stable;
    } catch (error) {
      errors.push(`action failed: ${String(error.message ?? error).split("\n")[0]}`);
    }
  }
  const state = `${screen.name}@${viewport.name}-${theme}`;
  await page.evaluate(() => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== window.__fingerprintQuiet,
    );
  });
  await page.evaluate(freshLayout);
  // Images can settle after the DOM: shoot until two consecutive shots agree. A screen that
  // polls (the desktop rail every 5 s) can re-render in between, so the page is recorded before
  // and after the shots and the whole round repeats until both records agree.
  const shoot = () => page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
  let record;
  let shot;
  for (let round = 0; ; round += 1) {
    const before = JSON.stringify(await page.evaluate(recordPage));
    shot = await shoot();
    let settled = false;
    for (let attempt = 0; attempt < 8 && !settled; attempt += 1) {
      await page.waitForTimeout(250);
      const again = await shoot();
      settled = again.equals(shot);
      shot = again;
    }
    const after = JSON.stringify(await page.evaluate(recordPage));
    record = JSON.parse(after);
    if ((settled && before === after) || round === 4) {
      if (!settled) errors.push("screenshot did not settle");
      if (before !== after) errors.push("page kept changing");
      break;
    }
    await page.evaluate(settlePage);
    await page.evaluate(freshLayout);
  }
  record.state = state;
  record.errors = errors;
  record.stable = stable;
  writeFileSync(join(outDir, "shots", `${state}.png`), shot);
  writeFileSync(join(outDir, "states", `${state}.json.gz`), gzipSync(JSON.stringify(record)));
  // The DOM itself, for tools that ask which elements a selector matches (not compared).
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  writeFileSync(join(outDir, "dom", `${state}.html.gz`), gzipSync(html));
  await context.close();
  return { state, elements: record.elements.length, stable, errors };
}

async function capture(outArg, flags) {
  const started = Date.now();
  const outDir = resolve(outArg);
  mkdirSync(join(outDir, "states"), { recursive: true });
  mkdirSync(join(outDir, "shots"), { recursive: true });
  mkdirSync(join(outDir, "dom"), { recursive: true });
  const dist = resolve(flags.dist ?? join(webDir, "dist-demo"));
  if (!flags["no-build"]) {
    const vite = join(repoRoot, "node_modules/.bin/vite");
    const build = spawnSync(vite, ["build", "--logLevel", "error"], {
      cwd: webDir,
      env: { ...process.env, DESKMATES_DEMO: "1" },
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("demo build failed");
  }
  // Keep the built stylesheet next to the fingerprint for static diffing.
  for (const file of readdirSync(join(dist, "assets"))) {
    if (file.endsWith(".css"))
      writeFileSync(join(outDir, "demo.css"), readFileSync(join(dist, "assets", file)));
  }
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = loadPlaywright();
  const browser = await launchChromium(chromium);
  const found = await discover(browser, base);
  const only = flags.only ? new RegExp(flags.only) : null;
  const jobs = [];
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const screen of screens(found)) {
        const state = `${screen.name}@${viewport.name}-${theme}`;
        if (!only || only.test(state)) jobs.push({ viewport, theme, screen });
      }
    }
  }
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Number(flags.jobs ?? 4) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const result = await captureState(browser, base, job.viewport, job.theme, job.screen, outDir);
      results.push(result);
      const note = [result.stable ? "" : "unstable", ...result.errors].filter(Boolean).join("; ");
      console.log(`${result.state}: ${result.elements} elements${note ? ` (${note})` : ""}`);
    }
  });
  await Promise.all(workers);
  await browser.close();
  server.close();
  results.sort((a, b) => a.state.localeCompare(b.state));
  const meta = {
    format: FORMAT,
    browser: browser.version(),
    fixedTime: FIXED_TIME,
    found,
    states: results.map((r) => r.state),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  writeFileSync(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`captured ${results.length} states into ${outDir} in ${meta.seconds}s`);
}

// ---------- compare ----------

function readState(dir, state) {
  return JSON.parse(gunzipSync(readFileSync(join(dir, "states", `${state}.json.gz`))).toString());
}

function fullStyle(defaults, key, diff) {
  return { ...(defaults[key] ?? {}), ...diff };
}

function loadPng() {
  for (const candidate of ["pngjs", join(repoRoot, "node_modules/pngjs")]) {
    try {
      return require(candidate).PNG;
    } catch {
      // try the next one
    }
  }
  return null;
}

function pixelDiff(PNG, fileA, fileB, tolerance) {
  const a = readFileSync(fileA);
  const b = readFileSync(fileB);
  if (a.equals(b)) return { pixels: 0 };
  if (!PNG) return { pixels: -1, note: "images differ (pngjs not found, no pixel count)" };
  const imgA = PNG.sync.read(a);
  const imgB = PNG.sync.read(b);
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    return {
      pixels: -1,
      note: `size ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`,
    };
  }
  let pixels = 0;
  let faint = 0;
  for (let i = 0; i < imgA.data.length; i += 4) {
    let delta = 0;
    for (let k = 0; k < 4; k += 1) {
      delta = Math.max(delta, Math.abs(imgA.data[i + k] - imgB.data[i + k]));
    }
    if (delta > tolerance.channel) pixels += 1;
    else if (delta > 0) faint += 1;
  }
  // A few faint pixels are edge antialiasing noise; many are a real (if subtle) change.
  if (faint > tolerance.faint) {
    pixels += faint;
    faint = 0;
  }
  return { pixels, faint };
}

function describe(el) {
  const cls = el.attrs?.class ? `.${el.attrs.class.trim().split(/\s+/).join(".")}` : "";
  return `${el.path} <${el.tag}${cls.length > 80 ? `${cls.slice(0, 80)}…` : cls}>`;
}

function compareStates(a, b) {
  const lines = [];
  for (const key of ["title", "hash", "stable"]) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      lines.push(`page ${key}: ${JSON.stringify(a[key])} -> ${JSON.stringify(b[key])}`);
  }
  if (JSON.stringify(a.errors) !== JSON.stringify(b.errors))
    lines.push(`page errors: ${JSON.stringify(a.errors)} -> ${JSON.stringify(b.errors)}`);
  for (const key of ["scroll", "size"]) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      lines.push(`page ${key}: ${a[key]} -> ${b[key]}`);
  }
  const byPath = new Map(b.elements.map((el) => [el.path, el]));
  const seen = new Set();
  for (const elA of a.elements) {
    const elB = byPath.get(elA.path);
    if (!elB) {
      lines.push(`missing in B: ${describe(elA)}`);
      continue;
    }
    seen.add(elA.path);
    const where = describe(elA);
    for (const key of ["tag", "text", "value"]) {
      if (elA[key] !== elB[key])
        lines.push(`${where} ${key}: ${JSON.stringify(elA[key])} -> ${JSON.stringify(elB[key])}`);
    }
    for (const key of ["rect", "scroll"]) {
      if (JSON.stringify(elA[key]) !== JSON.stringify(elB[key]))
        lines.push(`${where} ${key}: ${JSON.stringify(elA[key])} -> ${JSON.stringify(elB[key])}`);
    }
    const attrNames = new Set([...Object.keys(elA.attrs), ...Object.keys(elB.attrs)]);
    for (const name of attrNames) {
      if (elA.attrs[name] !== elB.attrs[name])
        lines.push(
          `${where} @${name}: ${JSON.stringify(elA.attrs[name])} -> ${JSON.stringify(elB.attrs[name])}`,
        );
    }
    const styleA = fullStyle(a.defaults, elA.d, elA.style);
    const styleB = fullStyle(b.defaults, elB.d, elB.style);
    for (const prop of new Set([...Object.keys(styleA), ...Object.keys(styleB)])) {
      if (styleA[prop] !== styleB[prop])
        lines.push(
          `${where} ${prop}: ${JSON.stringify(styleA[prop])} -> ${JSON.stringify(styleB[prop])}`,
        );
    }
    const pseudoNames = new Set([
      ...Object.keys(elA.pseudo ?? {}),
      ...Object.keys(elB.pseudo ?? {}),
    ]);
    const divKey = "http://www.w3.org/1999/xhtml|div";
    for (const pseudo of pseudoNames) {
      const pA = elA.pseudo?.[pseudo];
      const pB = elB.pseudo?.[pseudo];
      if (!pA || !pB) {
        lines.push(
          `${where}${pseudo}: ${pA ? "present" : "absent"} -> ${pB ? "present" : "absent"}`,
        );
        continue;
      }
      const sA = fullStyle(a.defaults, divKey, pA);
      const sB = fullStyle(b.defaults, divKey, pB);
      for (const prop of new Set([...Object.keys(sA), ...Object.keys(sB)])) {
        if (sA[prop] !== sB[prop])
          lines.push(
            `${where}${pseudo} ${prop}: ${JSON.stringify(sA[prop])} -> ${JSON.stringify(sB[prop])}`,
          );
      }
    }
  }
  for (const elB of b.elements) if (!seen.has(elB.path)) lines.push(`extra in B: ${describe(elB)}`);
  return lines;
}

function compare(dirA, dirB, flags) {
  const limit = Number(flags.limit ?? 25);
  const metaA = JSON.parse(readFileSync(join(dirA, "meta.json"), "utf8"));
  const metaB = JSON.parse(readFileSync(join(dirB, "meta.json"), "utf8"));
  let differences = 0;
  if (metaA.browser !== metaB.browser) {
    console.log(`browser differs: ${metaA.browser} vs ${metaB.browser}`);
    differences += 1;
  }
  if (JSON.stringify(metaA.found) !== JSON.stringify(metaB.found)) {
    console.log(
      `discovered links differ: ${JSON.stringify(metaA.found)} -> ${JSON.stringify(metaB.found)}`,
    );
    differences += 1;
  }
  const statesB = new Set(metaB.states);
  for (const state of metaA.states)
    if (!statesB.has(state)) {
      console.log(`state missing in B: ${state}`);
      differences += 1;
    }
  for (const state of metaB.states)
    if (!metaA.states.includes(state)) {
      console.log(`state extra in B: ${state}`);
      differences += 1;
    }
  const PNG = loadPng();
  let elements = 0;
  let pixelStates = 0;
  // Screenshot tolerance: a pixel whose channels all differ by at most `channel` is faint; up
  // to `faint` faint pixels per screenshot are antialiasing noise (a rotated icon's edge on a
  // loaded machine), more count as differing pixels. `--pixel-tolerance 0` compares exactly.
  const tolerance = {
    channel: Number(flags["pixel-tolerance"] ?? 16),
    faint: Number(flags["faint-pixels"] ?? 64),
  };
  let faintStates = 0;
  const faintNotes = [];
  const shared = metaA.states.filter((s) => statesB.has(s));
  for (const state of shared) {
    const a = readState(dirA, state);
    const b = readState(dirB, state);
    elements += a.elements.length;
    const lines = compareStates(a, b);
    const shot = pixelDiff(
      PNG,
      join(dirA, "shots", `${state}.png`),
      join(dirB, "shots", `${state}.png`),
      tolerance,
    );
    if (shot.faint) {
      faintStates += 1;
      faintNotes.push(`${state}: ${shot.faint} faint pixels`);
    }
    if (lines.length === 0 && shot.pixels === 0) continue;
    differences += lines.length + (shot.pixels === 0 ? 0 : 1);
    if (shot.pixels !== 0) pixelStates += 1;
    const pixelNote =
      shot.pixels === 0 ? "screenshot equal" : (shot.note ?? `${shot.pixels} pixels differ`);
    console.log(`\n== ${state}: ${lines.length} differences, ${pixelNote}`);
    for (const line of lines.slice(0, limit)) console.log(`  ${line}`);
    if (lines.length > limit) console.log(`  ... ${lines.length - limit} more (--limit N)`);
  }
  if (faintStates) {
    console.log(`\nwithin antialiasing tolerance (not differences): ${faintNotes.join("; ")}`);
  }
  console.log(
    `\ncompared ${shared.length} states, ${elements} elements: ${differences === 0 ? "no differences" : `${differences} differences, ${pixelStates} screenshots differ`}`,
  );
  return differences === 0 ? 0 : 1;
}

// ---------- main ----------

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
if (command === "capture" && rest.length === 1) {
  await capture(rest[0], flags);
} else if (command === "compare" && rest.length === 2) {
  process.exitCode = compare(resolve(rest[0]), resolve(rest[1]), flags);
} else {
  console.error(
    "usage: ui-fingerprint.mjs capture <outDir> [--no-build] [--dist <dir>] [--jobs N] [--only <regex>]\n" +
      "       ui-fingerprint.mjs compare <dirA> <dirB> [--limit N] [--pixel-tolerance N] [--faint-pixels N]",
  );
  process.exitCode = 2;
}
