// UI smoke-test driver (developer tool): opens the app in headless Chrome and runs steps.
// 1) serve the app:  python -m http.server 8765  (inside src)
// 2) node tests/ui-driver.mjs steps.json out-dir
// steps: "js expression" (result printed; a result {saveFiles:[{path, base64}]} is written to disk) or {"shot": "name", "wait": ms} (screenshot saved to out-dir/name.png)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , stepsFile, outDir = tmpdir()] = process.argv;
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'));
mkdirSync(outDir, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9333', `--user-data-dir=${join(tmpdir(), 'quest-ui-driver')}`, 'about:blank']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 40 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page'); } catch { /* starting */ }
  await sleep(250);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map(), errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) pending.get(m.id)?.(m);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:8765/index.html' });
await sleep(1500);
for (const s of steps) {
  if (typeof s === 'object') {
    await sleep(s.wait || 300);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `${s.shot}.png`), Buffer.from(r.result.data, 'base64'));
    console.log('shot', join(outDir, `${s.shot}.png`));
    continue;
  }
  const r = await send('Runtime.evaluate', { expression: s, awaitPromise: true, returnByValue: true });
  const value = r.result.result?.value;
  if (value?.saveFiles) { // {saveFiles: [{path, base64}], ...info}: write files produced inside the page
    for (const f of value.saveFiles) { writeFileSync(f.path, Buffer.from(f.base64, 'base64')); console.log('saved', f.path); }
    delete value.saveFiles;
  }
  console.log(r.result.exceptionDetails ? `THROW ${r.result.exceptionDetails.exception?.description}` : `=> ${JSON.stringify(value)}`);
}
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'NO ERRORS');
ws.close();
chrome.kill();
process.exit(0);
