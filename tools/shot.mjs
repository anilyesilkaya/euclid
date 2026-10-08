// Zero-dependency headless-Chromium screenshot driver over the Chrome DevTools
// Protocol (see cdp.mjs for why this doesn't use Playwright).
//
// Usage:
//   node tools/shot.mjs <url> <out.png> [width] [height] [waitMs] [evalFile]
//
// If evalFile is given, its contents are evaluated in the page (via
// Runtime.evaluate, awaiting a returned promise) after load and before the
// screenshot — used to script interactions (click a tool, draw a shape, etc.).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const [, , url, out, w = '1280', h = '860', waitMs = '600', evalFile] = process.argv;
if (!url || !out) {
  console.error('usage: node tools/shot.mjs <url> <out.png> [w] [h] [waitMs] [evalFile]');
  process.exit(2);
}

let browser;
try {
  browser = await launch({ width: Number(w), height: Number(h) });
  const { cdp } = browser;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await sleep(Number(waitMs));
  if (evalFile && existsSync(evalFile)) {
    const expr = readFileSync(evalFile, 'utf8');
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
    if (r.result && r.result.value !== undefined) console.log('eval result:', JSON.stringify(r.result.value));
    await sleep(Number(waitMs));
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('wrote', out);
} catch (err) {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
} finally {
  browser?.close();
}
