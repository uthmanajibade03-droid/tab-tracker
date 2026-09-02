'use strict';

/*
 * Renders the extension's real pages with a stubbed chrome.* and captures
 * them, then composes each onto a 1280x800 canvas — the Chrome Web Store's
 * screenshot size.
 *
 * Real UI, real stylesheets, real scripts. Only the storage underneath is
 * seeded, so what ends up in the store listing is what the extension actually
 * draws rather than a mockup that will drift from it.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const EXT = 'C:/Users/ajiba/Videos/Desktop/tab-tracker';
const OUT = __dirname;
const STORE_W = 1280;
const STORE_H = 800;

/** Captures one extension page at its natural size. */
async function capture(file, width, height, prep) {
  const win = new BrowserWindow({
    width, height, show: false,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'stub.js'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(EXT, file));
  // Let the page's own async render settle before capturing.
  await new Promise(r => setTimeout(r, 1400));
  if (prep) { await win.webContents.executeJavaScript(prep); await new Promise(r => setTimeout(r, 700)); }
  /* Crop to the real content bottom. The window is deliberately taller than
     the page so nothing is clipped while rendering; capturing the whole thing
     would frame the UI against a slab of empty background. */
  const h = await win.webContents.executeJavaScript(`(() => {
    let bottom = 0;
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.height && r.width) bottom = Math.max(bottom, r.bottom);
    }
    return Math.ceil(bottom + 12);
  })()`);
  const cropH = (h && h > 80) ? Math.min(h, height) : height;
  const img = await win.webContents.capturePage({ x: 0, y: 0, width, height: cropH });
  win.destroy();
  return img;
}

/**
 * Places a captured page on a 1280x800 backdrop with a caption.
 *
 * Composed in a real browser window rather than by pixel-pushing, so the
 * caption uses the same typeface and spacing discipline as the product's own
 * pages instead of something bolted on.
 */
async function compose(png, caption, sub, outFile, scale) {
  // Written to disk and referenced relatively: a base64 PNG inline in a
  // data: URL blows past Electron's URL length limit.
  const shotFile = path.join(OUT, '_tmp-' + outFile);
  fs.writeFileSync(shotFile, png);
  const pageFile = path.join(OUT, '_tmp-' + outFile.replace('.png','') + '.html');
  const win = new BrowserWindow({
    width: STORE_W, height: STORE_H, show: false,
    /* The store wants exactly 1280x800. Without useContentSize the frame
       chrome is counted in those numbers and the capture comes out short. */
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: false },
  });

  const html = `<!doctype html><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&display=swap');
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${STORE_W}px; height: ${STORE_H}px; overflow: hidden; }
  body {
    background: #f6f7f6;
    font-family: "Inter Tight", "Segoe UI", system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center;
    padding: 52px 40px 0;
  }
  h1 {
    margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -0.025em;
    color: #141715; text-align: center;
  }
  p {
    margin: 10px 0 0; font-size: 15px; color: #5b625e;
    text-align: center; max-width: 64ch; line-height: 1.5;
  }
  .frame {
    margin-top: 34px;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 24px 60px -20px rgba(0,0,0,.30);
    background: #fff;
  }
  img { display: block; }
</style>
<h1>${caption}</h1>
<p>${sub}</p>
<div class="frame"><img id="s" src="${path.basename(shotFile)}"></div>
<script>
  // Scale to fit the space left under the caption, never upscaling past 1:1.
  const img = document.getElementById('s');
  img.onload = () => {
    const avail = ${STORE_H} - img.getBoundingClientRect().top - 72;
    const natural = img.naturalWidth;
    const byHeight = avail / img.naturalHeight * natural;
    img.style.width = Math.min(natural * ${scale || 1}, byHeight, ${STORE_W - 120}) + 'px';
    document.title = 'ready';
  };
</script>`;

  fs.writeFileSync(pageFile, html);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('  did-fail-load:', code, desc, url));
  win.webContents.on('console-message', (_e, lvl, msg) => console.log('  page console:', msg));
  // pathToFileURL rather than loadFile: on Windows the latter produced a
  // file:// URL with backslashes, which fails to load.
  /* Electron can reject this promise while the page nonetheless renders, so
     the result is judged by what the window actually shows, not by whether
     the load promise settled cleanly. */
  try { await win.loadURL(pathToFileURL(pageFile).href); }
  catch (err) { console.log('  (load reported ' + err.code + '; continuing to capture)'); }
  await new Promise(r => setTimeout(r, 1600)); // let the webfont land
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, outFile), img.toPNG());
  win.destroy();
  fs.unlinkSync(shotFile); fs.unlinkSync(pageFile);
  console.log('wrote', outFile);
}

/* Each capture destroys its window, which momentarily leaves none open — and
   Electron quits the app by default at that point, killing the run mid-way.
   This script decides when it is finished. */
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  // 1 — popup, stats tab
  let shot = await capture('popup.html', 384, 560,
    `document.querySelector('[data-tab="stats"]').click();`);
  await compose(shot.toPNG(), 'See where your time actually goes',
    'Every site you visit, ranked by the time you were really there — not just how long the tab was open.',
    'store-1-stats.png', 1.15);

  // 2 — popup, to-dos
  shot = await capture('popup.html', 384, 560, null);
  await compose(shot.toPNG(), 'To-dos that live where you work',
    'Personal and shared lists in the same place as your time. Add one from any page with a keyboard shortcut or a right-click.',
    'store-2-todos.png', 1.15);

  // 3 — dashboard
  shot = await capture('dashboard.html', 1100, 760, null);
  await compose(shot.toPNG(), 'A full day, broken down',
    'Pick any day and see every site, how many visits, and what share of your attention it took.',
    'store-3-dashboard.png', 1);

  // 4 — settings
  shot = await capture('options.html', 700, 720, null);
  await compose(shot.toPNG(), 'Yours by default, shared only if you ask',
    'Time tracking, to-dos and prayer reminders all work with no account. Only voice calls need a server.',
    'store-4-settings.png', 1);

  app.quit();
}).catch(err => { console.error(err); app.exit(1); });
