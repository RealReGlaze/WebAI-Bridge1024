/** 校准 aistudio.xiaomimimo.com 对话页骨架：输入框/按钮/消息块/登录指示 */
import { attachEdge } from '../src/browser/edge.js';

const ctx = await attachEdge(9223); // 复用专用 Edge（当前在位）——仅新开一个校准标签，结束即关
const page = await ctx.newPage();
try {
  await page.goto('https://aistudio.xiaomimimo.com/#/c', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(9000);
  console.log('url:', page.url());
  const info = (await page.evaluate(`(() => {
    const clean = (s) => s.replace(/\\n{2,}/g, '\\n');
    return {
      title: document.title,
      textareas: Array.from(document.querySelectorAll('textarea')).map(t => ({ id: t.id, name: t.name, placeholder: t.placeholder, cls: (t.className || '').slice(0, 80) })),
      editables: Array.from(document.querySelectorAll('[contenteditable=true]')).slice(0, 6).map(e => ({ tag: e.tagName, cls: (e.className || '').slice(0, 80), ph: e.getAttribute('placeholder'), dataPh: e.getAttribute('data-placeholder') })),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 30).map(b => ({ t: (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24), dis: b.disabled, cls: (b.className || '').slice(0, 40) })),
      bodyTail: clean((document.body.innerText || '')).slice(-1200)
    };
  })()`)) as Record<string, unknown>;
  console.log(JSON.stringify(info, null, 1));
  } finally {
    await page.close();
  }
  process.exit(0);
