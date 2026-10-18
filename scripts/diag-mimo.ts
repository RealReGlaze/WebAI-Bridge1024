/** 诊断：打开 mimo 主页，等 React 渲染后抽取所有链接与含 demo/chat 的 href */
import { attachEdge } from '../src/browser/edge.js';

const ctx = await attachEdge(9223);
const page = await ctx.newPage();
try {
  await page.goto('https://mimo.xiaomi.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6000);
  const hrefs = await page.evaluate(`(() => {
    return Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(Boolean);
  })()`);
  console.log('hrefs:', JSON.stringify([...new Set(hrefs as string[])], null, 1));
  // 找 "Web Demo" 附近文本
  const demoInfo = await page.evaluate(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (t.length < 40 && /web demo|体验|在线|demo/i.test(t)) out.push(t + ' -> ' + (el.closest('a')?.getAttribute('href') ?? el.tagName));
    }
    return out.slice(0, 15);
  })()`);
  console.log('demo-ish:', JSON.stringify(demoInfo, null, 1));
} finally {
  await page.close();
}
process.exit(0);
