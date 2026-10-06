// Produces the screenshots used by site/index.html.
//
// Drives the packaged build (frontend/dist) in headless Chrome over the DevTools
// protocol, so the pictures on the presentation site are the real application,
// not mock-ups. Run from the repo root:
//
//   node site/capture.mjs
//
// Needs a static server on PORT serving frontend/dist (the script starts one).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(HERE, "img");
const DIST = resolve(ROOT, "frontend/dist");
const PORT = 5620;
const CDP_PORT = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CDP plumbing ----------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else slot.resolve(msg.result);
    });
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP socket failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + expression);
    return r.result.value;
  }
}

// ---- helpers used inside the page ------------------------------------------

const waitFor = async (cdp, selector, timeout = 15000) => {
  const started = Date.now();
  for (;;) {
    if (await cdp.eval(`return Boolean(document.querySelector(${JSON.stringify(selector)}));`)) {
      return;
    }
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${selector}`);
    await sleep(120);
  }
};

// Real input, not synthetic DOM events: the board calls setPointerCapture on
// pointerdown, and that throws for a pointer id the browser never saw — the
// stroke would never start.
const mouse = (cdp, type, x, y, buttons) =>
  cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });

const click = async (cdp, selector) => {
  const box = await cdp.eval(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `);
  if (!box) throw new Error(`cannot click ${selector}`);
  await mouse(cdp, "mouseMoved", box.x, box.y, 0);
  await mouse(cdp, "mousePressed", box.x, box.y, 1);
  await mouse(cdp, "mouseReleased", box.x, box.y, 0);
  await sleep(260);
};

// Writes on the board canvas: press, a run of moves with the button held, release.
const draw = async (cdp, points) => {
  const origin = await cdp.eval(`
    const r = document.querySelector('[data-testid="whiteboard-canvas"]').getBoundingClientRect();
    return { x: r.x, y: r.y };
  `);
  const abs = points.map(([x, y]) => [origin.x + x, origin.y + y]);
  await mouse(cdp, "mouseMoved", abs[0][0], abs[0][1], 0);
  await mouse(cdp, "mousePressed", abs[0][0], abs[0][1], 1);
  for (const [x, y] of abs.slice(1)) await mouse(cdp, "mouseMoved", x, y, 1);
  const last = abs[abs.length - 1];
  await mouse(cdp, "mouseReleased", last[0], last[1], 0);
  await sleep(140);
};

// Empties the sheet. Generous: an extra undo on an empty board costs nothing.
const undoAll = async (cdp) => {
  for (let i = 0; i < 30; i++) await click(cdp, '[data-testid="btn-undo"]').catch(() => {});
  await sleep(300);
};

// A freehand-looking polyline between two points, so strokes do not look
// machine-straight in the pictures.
const wobble = (x1, y1, x2, y2, amp = 1.6, steps = 26) => {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([
      x1 + (x2 - x1) * t + Math.sin(t * 7) * amp,
      y1 + (y2 - y1) * t + Math.cos(t * 9) * amp,
    ]);
  }
  return pts;
};

// padBottom is given its own value for the popovers that float just above the
// toolbar: a symmetric margin there catches the top of the button underneath
// and leaves a sliced circle at the bottom of the picture.
const shot = async (cdp, name, selector, pad = 0, padBottom = pad) => {
  const box = await cdp.eval(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  `);
  if (!box) throw new Error(`no element to shoot: ${selector}`);
  const res = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.w + pad * 2,
      height: box.h + pad + padBottom,
      scale: 2,
    },
  });
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(res.data, "base64"));
  console.log(`  ✓ ${name}.png`);
};

// Crops a region of the board itself, in canvas coordinates.
const shotArea = async (cdp, name, x, y, w, h) => {
  const origin = await cdp.eval(`
    const r = document.querySelector('[data-testid="whiteboard-canvas"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  `);
  // kept inside the canvas: a clip that overflows captures the chrome around it
  const cx = Math.max(0, Math.min(x, origin.w));
  const cy = Math.max(0, Math.min(y, origin.h));
  const res = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: {
      x: origin.x + cx,
      y: origin.y + cy,
      width: Math.min(w, origin.w - cx),
      height: Math.min(h, origin.h - cy),
      scale: 2,
    },
  });
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(res.data, "base64"));
  console.log(`  ✓ ${name}.png`);
};

// Where the sheet sits inside the canvas, found by reading the pixels: the
// sheet is pure #FFFFFF while the workspace around it is #FAFAFA, so only an
// exact match separates the two. Drawing outside the sheet is pointless — the
// renderer clips annotations to it.
const sheetRect = async (cdp) => {
  const r = await cdp.eval(`
    const c = document.querySelector('[data-testid="whiteboard-canvas"]');
    const ctx = c.getContext("2d");
    const box = c.getBoundingClientRect();
    const kx = c.width / box.width;
    const ky = c.height / box.height;
    const white = (d, i) => d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255;

    const row = Math.round(c.height / 2);
    const h = ctx.getImageData(0, row, c.width, 1).data;
    let x1 = -1, x2 = -1;
    for (let x = 0; x < c.width; x++) if (white(h, x * 4)) { if (x1 < 0) x1 = x; x2 = x; }

    const col = Math.round((x1 + x2) / 2);
    const v = ctx.getImageData(col, 0, 1, c.height).data;
    let y1 = -1, y2 = -1;
    for (let y = 0; y < c.height; y++) if (white(v, y * 4)) { if (y1 < 0) y1 = y; y2 = y; }

    if (x1 < 0 || y1 < 0) return null;
    return { x: x1 / kx, y: y1 / ky, w: (x2 - x1) / kx, h: (y2 - y1) / ky };
  `);
  if (!r) throw new Error("sheet not found on the canvas");
  return r;
};

// ---- run -------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: DIST,
  stdio: "ignore",
});

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  "--user-data-dir=/tmp/geoboard-capture-profile",
  "--window-size=1440,1080",
  "--force-device-scale-factor=1",
  "--hide-scrollbars",
  "--no-first-run",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

const stop = () => {
  chrome.kill();
  server.kill();
};
process.on("exit", stop);

try {
  // the debugging endpoint needs a moment
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      targets = (await r.json()).find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
  }
  if (!targets) throw new Error("Chrome DevTools endpoint never came up");

  const cdp = await Cdp.open(targets.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const base = `http://127.0.0.1:${PORT}/`;

  // Force the offline store: there is no FastAPI here, and a 404 on /api would
  // not trip the automatic fallback.
  await cdp.send("Page.navigate", { url: base });
  await sleep(1200);
  await cdp.eval(`localStorage.setItem("geoboard.offline", "1"); return true;`);
  await cdp.send("Page.navigate", { url: base });
  await waitFor(cdp, '[data-testid="home-screen"]');
  await sleep(600);

  console.log("accueil");
  await shot(cdp, "home", '[data-testid="home-screen"]');

  // open the settings panel on the home screen
  await click(cdp, '[data-testid="btn-settings"]');
  await waitFor(cdp, '[data-testid="settings-panel"]');
  await shot(cdp, "settings", '[data-testid="settings-panel"]', 10);
  await cdp.eval(`document.body.click(); return true;`);
  await sleep(300);

  console.log("création de la planche");
  await click(cdp, '[data-testid="btn-create-board"]');
  await waitFor(cdp, '[data-testid="new-board-dialog"]');
  await shot(cdp, "new-board", '[data-testid="new-board-dialog"]', 10);
  await click(cdp, '[data-testid="new-board-create"]');
  await waitFor(cdp, '[data-testid="whiteboard-canvas"]');
  await sleep(1500);

  console.log("barre d'outils");
  await shot(cdp, "toolbar", '[data-testid="floating-toolbar"] > div > div', 8);

  // A board can open fitted to the width, which puts most of the A4 below the
  // fold — the instruments, centred on the page, would be off screen. Fitting
  // the height makes the whole sheet visible, so every shot is reproducible.
  await click(cdp, '[data-testid="page-indicator"]');
  await waitFor(cdp, '[data-testid="page-nav-panel"]');
  await click(cdp, '[data-testid="pager-fit-height"]');
  await click(cdp, '[data-testid="page-nav-close"]');
  await sleep(600);

  const sheet = await sheetRect(cdp);
  console.log(`  feuille: ${Math.round(sheet.w)} x ${Math.round(sheet.h)} px`);
  // everything below is expressed as a fraction of the sheet, so the script
  // keeps working whatever the window size or the fit the board opened with
  const at = (fx, fy) => [sheet.x + sheet.w * fx, sheet.y + sheet.h * fy];
  const area = (fx, fy, fw, fh) => [
    sheet.x + sheet.w * fx,
    sheet.y + sheet.h * fy,
    sheet.w * fw,
    sheet.h * fh,
  ];
  const line = (fx1, fy1, fx2, fy2, amp) => {
    const [x1, y1] = at(fx1, fy1);
    const [x2, y2] = at(fx2, fy2);
    return wobble(x1, y1, x2, y2, amp);
  };

  // ---- pen: the four colours -----------------------------------------------
  console.log("crayons");
  for (let i = 0; i < 4; i++) {
    await click(cdp, `[data-testid="tool-pen-${i}"]`);
    await draw(cdp, line(0.12, 0.08 + i * 0.05, 0.84, 0.08 + i * 0.05, 2.4));
    await sleep(120);
  }
  await shotArea(cdp, "pens", ...area(0.06, 0.03, 0.88, 0.24));

  await click(cdp, '[data-testid="btn-pen-palette"]');
  await waitFor(cdp, '[data-testid="pen-palette-popover"]');
  await shot(cdp, "pen-palette", '[data-testid="pen-palette-popover"]', 10, -5);
  await cdp.eval(`document.body.click(); return true;`);
  await sleep(250);

  // ---- highlighter ---------------------------------------------------------
  console.log("surligneur");
  await click(cdp, '[data-testid="tool-highlighter"]');
  await waitFor(cdp, '[data-testid="highlighter-popover"]');
  await shot(cdp, "highlighter-panel", '[data-testid="highlighter-popover"]', 10, -5);
  await cdp.eval(`document.body.click(); return true;`);
  await sleep(250);
  // laid across two of the pen lines, to show the writing stays readable
  await draw(cdp, line(0.1, 0.13, 0.86, 0.13, 0.5));
  await sleep(250);
  await shotArea(cdp, "highlighter", ...area(0.06, 0.09, 0.88, 0.12));

  // ---- shapes --------------------------------------------------------------
  console.log("formes");
  await click(cdp, '[data-testid="tool-shape"]');
  await waitFor(cdp, '[data-testid="shape-popover"]');
  await shot(cdp, "shape-panel", '[data-testid="shape-popover"]', 10, 8);
  await click(cdp, '[data-testid="shape-triangle"]');
  await cdp.eval(`document.body.click(); return true;`);
  await sleep(250);
  await draw(cdp, [at(0.1, 0.42), at(0.2, 0.52), at(0.34, 0.62)]);
  await click(cdp, '[data-testid="tool-shape"]');
  await click(cdp, '[data-testid="shape-circle"]');
  await cdp.eval(`document.body.click(); return true;`);
  await sleep(250);
  await draw(cdp, [at(0.42, 0.42), at(0.5, 0.52), at(0.62, 0.62)]);
  await click(cdp, '[data-testid="tool-shape"]');
  await click(cdp, '[data-testid="shape-rect"]');
  await click(cdp, '[data-testid="shape-style-dashed"]');
  await cdp.eval(`document.body.click(); return true;`);
  await sleep(250);
  await draw(cdp, [at(0.68, 0.42), at(0.78, 0.52), at(0.9, 0.62)]);
  await sleep(250);
  await shotArea(cdp, "shapes", ...area(0.04, 0.38, 0.92, 0.29));

  // ---- maths ---------------------------------------------------------------
  console.log("écriture mathématique");
  await click(cdp, '[data-testid="tool-math"]');
  await waitFor(cdp, '[data-testid="math-composer"]');
  // typed rather than inserted from the palette, so the live preview is filled
  await click(cdp, '[data-testid="text-composer-input"]');
  await cdp.send("Input.insertText", { text: "\\frac{3}{4} + \\sqrt{2} = \\widehat{ABC}" });
  await sleep(300);
  // and one palette family unfolded, to show how the symbols are organised
  await click(cdp, '[data-testid="math-group-geometrie"]');
  await waitFor(cdp, '[data-testid="math-group-panel-geometrie"]');
  await sleep(400);
  await shot(cdp, "math", '[data-testid="math-composer"]', 10);
  await click(cdp, '[data-testid="text-composer-cancel"]');
  await sleep(300);

  // ---- set square ----------------------------------------------------------
  console.log("équerre");
  await click(cdp, '[data-testid="tool-set-square"]');
  await sleep(800);
  // the whole window, instrument on the sheet: the picture for the top of the site
  await shot(cdp, "overview", "body");
  // then the sheet is emptied, so the close-up shows the instrument alone and
  // not the strokes and figures left over from the previous sections
  await undoAll(cdp);
  await shotArea(cdp, "set-square", ...area(-0.06, 0.36, 1.12, 0.33));
  await click(cdp, '[data-testid="btn-sq-opacity"]');
  await waitFor(cdp, '[data-testid="sq-opacity-popover"]');
  await shot(cdp, "set-square-opacity", '[data-testid="sq-opacity-popover"]', 10, -5);
  await cdp.eval(`document.body.click(); return true;`);
  await sleep(250);
  await click(cdp, '[data-testid="tool-set-square"]'); // put it away
  await sleep(400);

  // ---- compass -------------------------------------------------------------
  console.log("compas");
  await click(cdp, '[data-testid="tool-compass"]');
  await sleep(900);
  await shotArea(cdp, "compass", ...area(0.02, 0.26, 0.96, 0.5));
  await click(cdp, '[data-testid="tool-compass"]');
  await sleep(300);

  // ---- clock + calculator --------------------------------------------------
  console.log("horloge et calculatrice");
  await click(cdp, '[data-testid="tool-clock"]');
  await sleep(700);
  await shot(cdp, "clock", '[data-testid="clock-widget"]', 8).catch(async () => {
    await shot(cdp, "clock", '[data-testid="clock-analog"]', 40);
  });
  await click(cdp, '[data-testid="tool-clock"]');
  await sleep(300);

  await click(cdp, '[data-testid="tool-calc"]');
  await sleep(600);
  for (const k of ["calc-frac", "calc-3", "calc-right", "calc-4", "calc-right", "calc-add", "calc-sqrt", "calc-2", "calc-eq"]) {
    await click(cdp, `[data-testid="${k}"]`);
  }
  await sleep(400);
  await shot(cdp, "calculator", '[data-testid="calculator-widget"]', 8).catch(async () => {
    await shot(cdp, "calculator", '[data-testid="calc-eq"]', 260);
  });
  await click(cdp, '[data-testid="tool-calc"]');
  await sleep(300);

  // ---- page navigator ------------------------------------------------------
  console.log("navigateur de pages");
  await click(cdp, '[data-testid="page-indicator"]');
  await waitFor(cdp, '[data-testid="page-nav-panel"]');
  await shot(cdp, "pager", '[data-testid="page-nav-panel"]', 10);

  console.log("\nterminé → site/img/");
} catch (err) {
  console.error("échec :", err.message);
  process.exitCode = 1;
} finally {
  stop();
}
