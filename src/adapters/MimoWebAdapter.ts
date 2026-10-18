/**
 * MimoWebAdapter —— 小米 MiMo 网页版（aistudio.xiaomimimo.com）适配器。
 *
 * 与 DeepSeekWebAdapter 相同边界：只模拟正常用户操作（输入框输入/回车发送、读取页面文本），
 * 不逆向任何请求签名、不绕过登录/风控/配额。
 *
 * 回复检测：MiMo 的 completion 协议尚未采样，先用「容器指纹差分 + 稳定判定」DOM 通道
 * （与 DeepSeek 的后备通道同思路）；登录后可先用 probe 校准选择器，
 * 若后续抓到稳定协议再升级网络通道。选择器均可在 config/backends.json 覆盖。
 */
import type { Page } from 'playwright-core';
import {
  type AdapterResult,
  type AdapterResultCode,
  type BackendCapabilities,
  type BackendConfig,
  type ConnectionState,
  type WaitForResponseOptions,
  type WebConversationState,
  IModelAdapter,
} from './IModelAdapter.js';
import { attachEdge, ensurePage, launchEdge } from '../browser/edge.js';

const DEFAULT_SELECTORS = {
  /** 消息输入框：aistudio 对话页仅一个 textarea（占位符随登录态变化） */
  input: 'textarea',
  /** 助手回复块（猜测候选，登录后用 probe 校准） */
  assistantMessage: 'div[class*="markdown"], div[class*="prose"]',
  /** 登录检测：出现「未登录/立即登录/登录」按钮即视为未登录 */
  loginIndicator: 'button:has-text("未登录"), button:has-text("立即登录"), button:has-text("登录")',
  /** 聊天区容器（指纹差分范围）；空 = body 全文 */
  chatContainer: '',
  /** 思考过程容器（登录后校准；空 = 不提取） */
  thinking: '',
} as const;

const NEW_CHAT_CANDIDATES = [
  'button:has-text("新对话")',
  'button:has-text("新建对话")',
  'button:has-text("新聊天")',
  'span:has-text("新对话")',
  'span:has-text("New chat")',
];

export interface MimoSelectors {
  input: string;
  assistantMessage: string;
  loginIndicator: string;
  chatContainer: string;
  thinking: string;
  newChatCandidates: string[];
}

function resolveSelectors(cfg: BackendConfig): MimoSelectors {
  const o = cfg.selectors ?? {};
  return {
    input: o['input'] ?? DEFAULT_SELECTORS.input,
    assistantMessage: o['assistantMessage'] ?? DEFAULT_SELECTORS.assistantMessage,
    loginIndicator: o['loginIndicator'] ?? DEFAULT_SELECTORS.loginIndicator,
    chatContainer: o['chatContainer'] ?? DEFAULT_SELECTORS.chatContainer,
    thinking: o['thinking'] ?? DEFAULT_SELECTORS.thinking,
    newChatCandidates: o['newChatCandidates']
      ? o['newChatCandidates'].split('|')
      : NEW_CHAT_CANDIDATES,
  };
}

export class MimoWebAdapter extends IModelAdapter {
  private cfg: BackendConfig;
  private sel: MimoSelectors;
  private page: Page | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private lastError: string | null = null;
  private lastReceivedAt: number | null = null;
  private lastSentAt: number | null = null;
  private loggedIn: boolean | null = null;
  private capabilities: BackendCapabilities = {
    multiTurnConversation: true,
    attachments: null,
    streaming: true,
  };

  constructor(cfg: BackendConfig) {
    super();
    this.cfg = cfg;
    this.sel = resolveSelectors(cfg);
  }

  get backendId(): string {
    return this.cfg.id;
  }

  getStatus() {
    return {
      connectionState: this.connectionState,
      capabilities: this.capabilities,
      lastError: this.lastError,
      lastReceivedAt: this.lastReceivedAt,
      lastSentAt: this.lastSentAt,
      loggedIn: this.loggedIn,
    };
  }

  private fail<T>(code: AdapterResultCode, message: string, retryable = false): AdapterResult<T> {
    this.lastError = message;
    return { ok: false, code, message, retryable };
  }

  async connect(): Promise<AdapterResult<void>> {
    try {
      this.connectionState = 'connecting';
      await launchEdge({
        debugPort: this.cfg.browser.debugPort,
        userDataDir: this.cfg.browser.profileDir,
        executablePath: this.cfg.browser.executablePath,
        startUrl: this.cfg.startUrl,
      });
      const context = await attachEdge(this.cfg.browser.debugPort);
      this.page = await ensurePage(context, this.cfg.startUrl.split('#')[0]!);
      const state = await this.detectLogin();
      if (state === 'ok') {
        this.connectionState = 'connected';
        this.loggedIn = true;
        return { ok: true, value: undefined };
      }
      if (state === 'login') {
        this.connectionState = 'login-required';
        this.loggedIn = false;
        return this.fail(
          'login-required',
          `需要在专用 Edge 窗口中手动登录小米账号（aistudio.xiaomimimo.com；登录态保存在项目 profile ${this.cfg.browser.profileDir} 中，之后无需重复登录）。`,
          false,
        );
      }
      this.connectionState = 'error';
      this.loggedIn = null;
      return this.fail('page-structure-changed', '输入框与登录指示均未找到，页面结构可能变化，请运行 probe 诊断。', false);
    } catch (e) {
      this.connectionState = 'error';
      this.lastError = e instanceof Error ? e.message : String(e);
      return this.fail('internal-error', this.lastError, true);
    }
  }

  private async detectLogin(): Promise<'ok' | 'login' | 'unknown'> {
    if (!this.page) return 'unknown';
    const input = this.page.locator(this.sel.input).first();
    // 冷启动时 SPA 渲染可能较慢；轮询至多 60s（与 DeepSeek 适配器同策略）
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (await input.isVisible().catch(() => false)) return 'ok';
      const loginBtn = await this.page!
        .locator(this.sel.loginIndicator)
        .first()
        .isVisible()
        .catch(() => false);
      if (loginBtn) return 'login';
      if (Date.now() + 3_000 > deadline) return 'unknown';
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  /** 诊断：dump 候选选择器命中情况 + textareas + 按钮文本（登录后校准选择器用） */
  async probe(): Promise<Record<string, unknown>> {
    if (!this.page) throw new Error('未连接');
    const out: Record<string, unknown> = { url: this.page.url() };
    const hits: Array<{ selector: string; count: number }> = [];
    for (const sel of [this.sel.input, this.sel.assistantMessage, this.sel.loginIndicator, this.sel.chatContainer, this.sel.thinking]) {
      if (!sel) continue;
      hits.push({ selector: sel, count: await this.page.locator(sel).count().catch(() => -1) });
    }
    out['selectorHits'] = hits;
    out['allTextareas'] = await this.page
      .locator('textarea')
      .evaluateAll((els) =>
        els.map((el) => ({ placeholder: (el as HTMLTextAreaElement).placeholder, rows: (el as HTMLTextAreaElement).rows })),
      );
    out['url'] = this.page.url();
    return out;
  }

  async sendMessage(text: string): Promise<AdapterResult<void>> {
    if (!this.page) return this.fail('not-connected', '尚未连接浏览器。');
    try {
      const input = this.page.locator(this.sel.input).first();
      if (!(await input.isVisible().catch(() => false))) {
        this.loggedIn = false;
        this.connectionState = 'login-required';
        return this.fail('login-required', '输入框不可见，可能登录已过期。请在专用 Edge 窗口重新登录。');
      }
      await input.click();
      await input.fill(text);
      await this.page.keyboard.press('Enter');
      this.lastSentAt = Date.now();
      return { ok: true, value: undefined };
    } catch (e) {
      return this.fail('internal-error', e instanceof Error ? e.message : String(e), true);
    }
  }

  private async containerText(): Promise<string> {
    if (!this.page) return '';
    if (this.sel.chatContainer) {
      const area = this.page.locator(this.sel.chatContainer).last();
      const t = await area.innerText().catch(() => '');
      if (t.trim()) return t;
    }
    return this.page.locator('body').innerText().catch(() => '');
  }

  /** 聊天区全文指纹（差分基准） */
  async captureChatFingerprint(): Promise<string> {
    return this.containerText();
  }

  private async readAssistant(): Promise<{ count: number; lastText: string }> {
    if (!this.page || !this.sel.assistantMessage) return { count: 0, lastText: '' };
    const blocks = this.page.locator(this.sel.assistantMessage);
    const count = await blocks.count().catch(() => 0);
    for (let i = count - 1; i >= Math.max(0, count - 3); i--) {
      const t = await blocks.nth(i).innerText().catch(() => '');
      if (t.trim()) return { count, lastText: MimoWebAdapter.sanitize(t) };
    }
    return { count, lastText: '' };
  }

  /** 清理常见 UI 文本残留 */
  private static sanitize(s: string): string {
    return s
      .split(/\r?\n/)
      .filter((line) => !/^(复制|下载|重新生成|Copy|Download|Regenerate)$/.test(line.trim()))
      .join('\n');
  }

  /** 思考过程提取：登录后配置 thinking 选择器后启用；否则返回空串 */
  private async readThinking(): Promise<string> {
    if (!this.page || !this.sel.thinking) return '';
    const blocks = this.page.locator(this.sel.thinking);
    const n = await blocks.count().catch(() => 0);
    if (n === 0) return '';
    return blocks.nth(n - 1).innerText().catch(() => '');
  }

  async waitForResponse(
    opts: WaitForResponseOptions & { baselineChatFp?: string },
  ): Promise<AdapterResult<{ text: string; complete: boolean; thinking?: string }>> {
    if (!this.page) return this.fail('not-connected', '尚未连接浏览器。');
    const deadline = Date.now() + opts.totalTimeoutMs;
    let stable = 0;
    let lastCandidate = '';
    let sawNew = false;
    const baselineFp = opts.baselineChatFp ?? '';
    while (Date.now() < deadline) {
      const fp = await this.containerText();
      const { lastText: lastMsg } = await this.readAssistant();

      // 新增内容：优先全文前缀差分，其次包含差分，再次尾尾对齐，最后回退最后一条助手块
      let delta = '';
      if (baselineFp && fp && fp.startsWith(baselineFp)) delta = fp.slice(baselineFp.length);
      else if (baselineFp && fp && fp.includes(baselineFp)) delta = fp.slice(fp.indexOf(baselineFp) + baselineFp.length);
      else if (baselineFp && fp) {
        const maxK = Math.min(baselineFp.length, fp.length);
        let k = maxK;
        while (k > 0 && baselineFp.slice(-k) !== fp.slice(-k)) k--;
        delta = fp.slice(0, fp.length - k);
      } else if (lastMsg.trim()) {
        delta = lastMsg;
      }
      if (delta.trim()) sawNew = true;

      // 剔除本次发送的用户消息回显
      const sentText = (opts.sentText ?? '').trim();
      if (sentText) {
        const idx = delta.indexOf(sentText);
        if (idx !== -1) delta = delta.slice(idx + sentText.length);
      }

      let candidate = delta.trim() ? MimoWebAdapter.sanitize(delta) : '';

      if (sawNew) {
        const rejected = (opts.rejectPatterns ?? []).find((p) => candidate.includes(p));
        if (rejected) return this.fail('rejected-by-site', `回复命中受限关键词：${rejected}`);
        if (candidate === lastCandidate) {
          stable += 1;
          if (stable >= opts.stablePolls && candidate.trim()) {
            this.lastReceivedAt = Date.now();
            this.connectionState = 'connected';
            this.lastError = null;
            return { ok: true, value: { text: candidate, complete: true, thinking: await this.readThinking() } };
          }
        } else {
          stable = 0;
        }
      }
      lastCandidate = candidate;
      await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
    }
    if (sawNew) {
      return this.fail('truncated-suspected', `响应未在时限内稳定（最后候选长度 ${lastCandidate.length}）。`, true);
    }
    return this.fail('timeout', `在 ${opts.totalTimeoutMs}ms 内未收到新增回复。`, true);
  }

  async getConversationState(): Promise<WebConversationState> {
    if (!this.page) throw new Error('未连接');
    const url = this.page.url();
    const m = /\/c\/([0-9a-zA-Z-]{6,})/.exec(url) ?? /#\/c\/([0-9a-zA-Z-]{6,})/.exec(url);
    const { count } = await this.readAssistant();
    return {
      conversationId: m?.[1] ?? null,
      url,
      lastSentAt: this.lastSentAt,
      lastReceivedAt: this.lastReceivedAt,
      assistantMessageCount: count,
    };
  }

  async startNewConversation(): Promise<AdapterResult<void>> {
    if (!this.page) return this.fail('not-connected', '尚未连接浏览器。');
    for (const c of this.sel.newChatCandidates) {
      const btn = this.page.locator(c).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await this.page.waitForTimeout(800);
        return { ok: true, value: undefined };
      }
    }
    // 兜底：直接回到对话首页（#/c），丢弃当前网页会话
    try {
      await this.page.goto(this.cfg.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.page.waitForTimeout(1500);
      return { ok: true, value: undefined };
    } catch (e) {
      return this.fail('internal-error', `新建会话失败：${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  async recoverConversation(state: WebConversationState): Promise<AdapterResult<WebConversationState>> {
    if (!this.page) return this.fail('not-connected', '尚未连接浏览器。');
    try {
      if (state.url && !state.url.startsWith(this.cfg.startUrl.split('#')[0] ?? '')) {
        await this.page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } else {
        await this.startNewConversation();
      }
      this.page.waitForTimeout(2000).catch(() => {});
      const cur = await this.getConversationState();
      return { ok: true, value: cur };
    } catch (e) {
      return this.fail('internal-error', e instanceof Error ? e.message : String(e), true);
    }
  }

  async disconnect(): Promise<void> {
    this.page = null;
    this.connectionState = 'disconnected';
  }
}
