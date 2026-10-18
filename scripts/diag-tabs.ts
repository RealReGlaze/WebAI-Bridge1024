import { attachEdge } from '../src/browser/edge.js';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('config/backends.json', 'utf-8')) as {
  backends: Array<{ startUrl: string; browser: { debugPort: number } }>;
};
const b = cfg.backends[0]!;
const ctx = await attachEdge(b.browser.debugPort);
const pages = ctx.pages();
console.log(`tabs=${pages.length}`);
for (const p of pages) {
  const url = p.url();
  const inputVis = await p.locator('textarea[name="search"]').first().isVisible().catch(() => `err`);
  const loginVis = await p.locator('button:has-text("登录")').first().isVisible().catch(() => false);
  const bodyLen = (await p.locator('body').innerText().catch(() => '')).length;
  console.log(`- url=${url}\n  inputVisible=${JSON.stringify(inputVis)} loginBtn=${loginVis} bodyChars=${bodyLen}`);
}
process.exit(0);
