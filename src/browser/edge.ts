/**
 * 专用 Edge 实例启动器 + CDP 附加器。
 *
 * 设计要点：
 * - 启动一个独立的 Edge 实例，带独立 user-data-dir（项目内 .runtime/），
 *   保证不会附加到用户正在使用的普通 Edge，也保证登录态可持久化。
 * - 不在代码/配置中保存任何账号凭据；登录由用户在该 Edge 窗口中手动完成。
 * - 仅使用 CDP（remote-debugging-port）附加，属于浏览器官方支持的调试通道。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

export interface EdgeLaunchOptions {
  debugPort: number;
  /** 绝对路径的 profile 目录 */
  userDataDir: string;
  /** Edge 可执行文件；留空自动探测 */
  executablePath?: string;
  /** 启动后打开的初始 URL */
  startUrl: string;
}

/** 常见 Edge 安装位置（Windows/macOS/Linux），末尾附带同引擎 Chromium 系回退（CDP 协议一致） */
const EDGE_CANDIDATES = [
  // Windows
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env['LOCALAPPDATA']
    ? path.win32.join(process.env['LOCALAPPDATA'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    : '',
  // macOS
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
  '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux（各发行版包名不同）
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/microsoft-edge-beta',
  // 回退：同引擎 Chromium 系
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function detectEdgePath(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit;
  for (const p of EDGE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `未找到 Edge/Chromium 可执行文件。可在 config/backends.json 中指定 browser.executablePath。已尝试：\n${EDGE_CANDIDATES.join('\n')}`,
  );
}

/** 是否已有监听该端口的调试实例 */
async function isCdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 启动专用 Edge 实例（幂等：若该端口已有调试实例则直接复用）。返回是否新启动。
 *  注意：实测 spawn 偶发出现「进程在但调试端口不开」（冷启动/更新冲突时）；失败自动重试一次。 */
export async function launchEdge(opts: EdgeLaunchOptions): Promise<boolean> {
  if (await isCdpAlive(opts.debugPort)) {
    console.log(`[edge] 端口 ${opts.debugPort} 已存在调试实例，直接复用。`);
    return false;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userDataDir = path.resolve(opts.userDataDir); // 相对路径防 cwd 漂移
    mkdirSync(userDataDir, { recursive: true });
    const exe = detectEdgePath(opts.executablePath);
    const args = [
      `--remote-debugging-port=${opts.debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeReginaBadging', // 减少首次运行干扰提示（可选特性）
      '--window-size=1400,950',
      opts.startUrl,
    ];
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    // 等待 CDP 端口就绪（最多 20s）
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isCdpAlive(opts.debugPort)) {
        console.log(`[edge] 已启动专用 Edge（pid=${child.pid}，端口=${opts.debugPort}，profile=${path.basename(userDataDir)}）。`);
        return true;
      }
    }
    if (attempt === 1) {
      console.log(`[edge] 首次启动未出现调试端口（pid=${child.pid}），重试一次…`);
      // 结束可能僵住的该实例再试
      try {
        process.kill(child.pid!, 'SIGKILL');
      } catch {
        /* 忽略 */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`Edge 已启动但 ${opts.debugPort} 端口始终未出现 CDP 调试服务（已重试）。请手动关闭同名 profile 的 Edge 窗口后再试。`);
}

/** 附加到该实例（必须先 launchEdge） */
export async function attachEdge(port: number): Promise<BrowserContext> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error('CDP 已连接但没有可用的浏览器 context。');
  return contexts[0]!;
}

/** 在 context 中确保打开了某 URL 的标签页并返回 */
export async function ensurePage(context: BrowserContext, url: string): Promise<Page> {
  for (const page of context.pages()) {
    if (page.url().startsWith(url)) return page;
  }
  const page = context.pages()[0] ?? (await context.newPage());
  if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  return page;
}
