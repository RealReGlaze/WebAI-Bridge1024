/**
 * 页面结构探测：用于首次接入/页面改版时校准选择器。
 * 只读诊断，不会点击、不会输入任何内容。
 */
import { ensurePage, attachEdge, launchEdge } from '../browser/edge.js';
import type { BackendConfig } from '../adapters/IModelAdapter.js';

export async function probePage(cfg: BackendConfig): Promise<Record<string, unknown>> {
  await launchEdge({
    debugPort: cfg.browser.debugPort,
    userDataDir: cfg.browser.profileDir,
    executablePath: cfg.browser.executablePath,
    startUrl: cfg.startUrl,
  });
  const context = await attachEdge(cfg.browser.debugPort);
  const page = await ensurePage(context, cfg.startUrl);
  // 给 SPA 一点渲染时间
  await new Promise((r) => setTimeout(r, 4000));

  const url = page.url();
  const title = await page.title();

  const textareas = await page
    .locator('textarea')
    .evaluateAll((els) =>
      els.map((el) => ({
        id: (el as HTMLElement).id,
        name: (el as HTMLTextAreaElement).name,
        placeholder: (el as HTMLTextAreaElement).placeholder,
        visible: !!((el as HTMLElement).offsetWidth || (el as HTMLElement).offsetHeight),
      })),
    );

  const inputs = await page
    .locator('div[contenteditable="true"]')
    .evaluateAll((els) => els.map((el) => ({ cls: el.className.slice(0, 120), text: (el.textContent ?? '').slice(0, 50) })));

  const loginLike = await page
    .locator('button, a')
    .evaluateAll((els) =>
      els
        .map((el) => (el.textContent ?? '').trim())
        .filter((t) => t && t.length <= 12)
        .filterUnique()
        .slice(0, 60),
    )
    .catch(() => []);

  const dsCount = await page.locator('div.ds-markdown').count();
  const iframeCount = await page.locator('iframe').count();
  const bodyStart = (await page.locator('body').innerText().catch(() => '')).slice(0, 1500);

  // CDP 层面观察到的全部标签页
  const tabUrls = context.pages().map((p) => p.url());

  return { url, title, tabUrls, textareas, contenteditables: inputs, buttons: loginLike, dsMarkdownCount: dsCount, iframeCount, bodyStart };
}

// Array.prototype.filterUnique 便捷扩展（探测用）
declare global {
  interface Array<T> {
    filterUnique(): T[];
  }
}
Array.prototype.filterUnique = function <T>(this: T[]): T[] {
  return Array.from(new Set(this));
};
