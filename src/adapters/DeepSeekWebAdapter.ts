/**
 * DeepSeekWebAdapter —— 通过 Playwright CDP 附加到用户已登录的专用 Edge 实例，
 * 在 chat.deepseek.com 上以正常网页交互方式收发消息。
 *
 * 重要边界：
 * - 仅模拟正常用户操作（输入框输入/回车发送，读取页面上的回复文本）。
 * - 不逆向任何请求签名、不绕过验证码/风控/付费限制。
 * - 页面结构可能变化：所有选择器都有默认值，可在 config/backends.json selectors 中覆盖。
 */
import type { CDPSession, Page } from 'playwright-core';
import {
  type AdapterResult,
  type AdapterResultCode,  type BackendCapabilities,
  type BackendConfig,
  type ConnectionState,
  type WaitForResponseOptions,
  type WebConversationState,
  IModelAdapter,
} from './IModelAdapter.js';
import { attachEdge, ensurePage, launchEdge } from '../browser/edge.js';

/** DeepSeek 网页的默认选择器（页面改版时在 config/backends.json 中覆盖，不必改代码） */
const DEFAULT_SELECTORS = {
  /** 消息输入框（2026-03 实测：输入框 id 为空，name="search"；保留旧 id 作后备） */
  input:
    'textarea[name="search"], textarea#chat-input, textarea[placeholder*="DeepSeek"]',
  /** 助手回复块 */
  assistantMessage: 'div.ds-markdown',
  /** 登录检测：出现“登录”按钮即视为未登录 */
  loginIndicator: 'button:has-text("登录"), a:has-text("Log in")',
  /** 禁用状态/空回复兜底占位：无 */
} as const;

/** 新建会话按钮候选（多个，逐一尝试；类名是哈希混淆的，只能文本定位） */
const DEFAULT_NEW_CHAT_CANDIDATES = [
  '[data-test-id="new-chat-button"]',
  'span:has-text("开启新对话")',
  'span:has-text("New chat")',
];

export interface DeepSeekSelectors {
  input: string;
  assistantMessage: string;
  loginIndicator: string;
  newChatCandidates: string[];
}

function resolveSelectors(cfg: BackendConfig): DeepSeekSelectors {
  const o = cfg.selectors ?? {};
  return {
    input: o['input'] ?? DEFAULT_SELECTORS.input,
    assistantMessage: o['assistantMessage'] ?? DEFAULT_SELECTORS.assistantMessage,
    loginIndicator: o['loginIndicator'] ?? DEFAULT_SELECTORS.loginIndicator,
    newChatCandidates: o['newChatCandidates']
      ? o['newChatCandidates'].split('|')
      : DEFAULT_NEW_CHAT_CANDIDATES,
  };
}

export class DeepSeekWebAdapter extends IModelAdapter {
  private cfg: BackendConfig;
  private sel: DeepSeekSelectors;
  private page: Page | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private lastError: string | null = null;
  private lastReceivedAt: number | null = null;
  private lastSentAt: number | null = null;
  private loggedIn: boolean | null = null;
  /** 网络通道：CDP 会话与捕获到的 completion 响应 */
  private cdp: CDPSession | null = null;
  private rx: Array<{ finishedAt: number; text: string; status: string }> = [];
  private cdpFailed = false;
  private capabilities: BackendCapabilities = {
    // 能力确认需登录后实测；null 表示未验证
    multiTurnConversation: null,
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
      this.page = await ensurePage(context, this.cfg.startUrl);
      await this.startNetCapture();
      const state = await this.detectLogin();
      if (state === 'ok') {
        this.connectionState = 'connected';
        this.loggedIn = true;
        return { ok: true, value: undefined };
      }
      if (state === 'login' ) {
        this.connectionState = 'login-required';
        this.loggedIn = false;
        return this.fail(
          'login-required',
          '需要在专用 Edge 窗口中手动登录 chat.deepseek.com（登录态会保存在项目 profile 中，之后无需重复登录）。',
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

  /**
   * 网络通道：旁听本会话自身的 POST /api/v0/chat/completion 响应流。
   * 边界说明：只是读取"自己已登录会话"的响应数据（请求由页面正常发出，
   * PoW 挑战由页面自行计算，我们不构造/重放/签名任何请求），
   * 相比 DOM 提取不受渲染层损伤，且 FINISHED 状态是确定性完成信号。
   */
  private async startNetCapture(): Promise<void> {
    if (!this.page) return;
    try {
      this.cdp = await this.page.context().newCDPSession(this.page);
      await this.cdp.send('Network.enable', { maxPostDataSize: 1_000_000 });
      const urlByReq = new Map<string, string>();
      /** 服务端明确宣告完成（response/status → FINISHED）才算整条响应；
       *  quasi_status 是 token 级状态（快照早期就为 FINISHED），不能作为完成信号。 */
      const DONE_RE = /"p":"response\/status","o":"SET","v":"FINISHED"/;
      const pushedIds = new Set<string>();
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      const tryFinalize = async (requestId: string) => {
        if (pushedIds.has(requestId) || this.cdpFailed) return;
        try {
          const body = (await this.cdp!.send('Network.getResponseBody', { requestId })) as { body: string };
          const raw = body.body ?? '';
          if (!DONE_RE.test(raw)) return; // 仍在流式传输，等待更多数据
          pushedIds.add(requestId);
          const parsed = DeepSeekWebAdapter.parseCompletionSse(raw);
          if (parsed.text.trim()) {
            this.rx.push({ finishedAt: Date.now(), text: parsed.text, status: parsed.status });
          }
        } catch {
          // body 可能被回收或暂时不可取；后续事件仍会重试
        }
      };
      this.cdp.on('Network.requestWillBeSent', (p) => {
        urlByReq.set(p.requestId, p.request.url);
      });
      this.cdp.on('Network.dataReceived', (p) => {
        const url = urlByReq.get(p.requestId);
        if (!url || !url.includes('/api/v0/chat/completion')) return;
        if (timers.has(p.requestId)) return;
        timers.set(
          p.requestId,
          setTimeout(() => {
            timers.delete(p.requestId);
            void tryFinalize(p.requestId);
          }, 500),
        );
      });
      this.cdp.on('Network.loadingFinished', (p) => {
        const url = urlByReq.get(p.requestId);
        if (!url || !url.includes('/api/v0/chat/completion')) return;
        void tryFinalize(p.requestId);
      });
    } catch {
      // CDP 网络通道不可用时静默降级到 DOM 通道
      this.cdpFailed = true;
    }
  }

  /** 解析 completion SSE：累积 fragments 内容与状态。已按 2026-10-18 真实流样本实现：
   *  - 快照 {"v":{"response":{"fragments":[...]}}} 中 content 为"当时已流出前缀"，绝对值语义；
   *  - 锚点追加 {"p":"response/fragments/-1/content","o":"APPEND","v":"X"}，-1 = 当前活动 fragment；
   *  - 续写简写 data: {"v":"X"}，无 p/o，隐式沿用上一次 /content 路径；
   *  - quasi_status 是 token 级状态（流早期就 FINISHED），不作为整体完成信号。 */
  static parseCompletionSse(sse: string): { text: string; status: string } {
    const fragText = new Map<number, string>();
    let maxIdx = -1; // 已见过的最大 fragment 下标（用于解析 -1 锚点）
    let lastContentPath: string | null = null; // 上一次显式 /content 路径（续写简写沿用）
    let status = '';
    const bare: string[] = [];
    const applyOp = (p: string, o: string, v: unknown) => {
      const m = /fragments\/(-?\d+)\/content$/.exec(p);
      if (m) {
        let idx = Number(m[1]);
        if (idx < 0) idx = maxIdx < 0 ? 0 : maxIdx; // -1 锚点 → 最近声明的 fragment
        else if (idx > maxIdx) maxIdx = idx;
        const s = typeof v === 'string' ? v : '';
        if (o === 'SET' || o === 'PATCH') fragText.set(idx, s);
        else fragText.set(idx, (fragText.get(idx) ?? '') + s); // APPEND / 缺省 = 追加
        lastContentPath = p;
        return;
      }
      if (p === 'response/status' || p.endsWith('/response/status')) {
        if (typeof v === 'string') status = v;
        return;
      }
      // quasi_status：token 级状态，忽略（不覆盖整体 status）
      if (p.endsWith('/quasi_status')) return;
      // 其他以 /content 结尾的路径（旧格式）
      if (/content$/.test(p) && typeof v === 'string' && (o === 'APPEND' || o === '')) {
        bare.push(v);
        lastContentPath = p;
      }
    };
    for (const rawLine of sse.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (typeof obj !== 'object' || obj === null) continue;
      const rec = obj as Record<string, unknown>;
      const v = rec['v'];
      if (typeof v === 'string' && lastContentPath !== null && !rec['p']) {
        // 续写简写：{"v":"X"} → 沿用上次 /content 路径追加
        applyOp(lastContentPath, 'APPEND', v);
        continue;
      }
      if (v && typeof v === 'object') {
        // 快照：{"v":{"response":{"fragments":[...] 或 {"v":{"response":...}}}
        const inner = v as Record<string, unknown>;
        const resp = (inner['response'] ?? inner) as Record<string, unknown>;
        if (Array.isArray(resp['fragments'])) {
          for (let i = 0; i < resp['fragments'].length; i++) {
            const frag = resp['fragments'][i] as Record<string, unknown> | null;
            if (!frag) continue;
            if (!frag['type'] || frag['type'] === 'RESPONSE') {
              if (typeof frag['content'] === 'string' && (fragText.get(i) ?? '').length < (frag['content'] as string).length) {
                fragText.set(i, frag['content'] as string); // 快照 = 绝对值
              }
              if (i > maxIdx) maxIdx = i;
            }
          }
        }
        continue;
      }
      if (typeof rec['p'] === 'string') {
        if (rec['o'] === 'BATCH' && Array.isArray(v)) {
          for (const sub of v as Array<Record<string, unknown>>) {
            if (typeof sub['p'] === 'string') applyOp(`${rec['p']}/${sub['p']}`, String(sub['o'] ?? ''), sub['v']);
          }
          continue;
        }
        applyOp(rec['p'], String(rec['o'] ?? ''), v);
        continue;
      }
      // 未知形状（如 event:title 的 {"content":"..."}）：仅当全程没有结构化内容时使用
      if (typeof rec['content'] === 'string') bare.push(rec['content'] as string);
    }
    const structured = [...fragText.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join('');
    const text = structured || bare.join('');
    return { text, status };
  }

  /** 已捕获的网络响应条数 */
  override async captureNetBaseline(): Promise<number> {
    return this.rx.length;
  }

  private async detectLogin(): Promise<'ok' | 'login' | 'unknown'> {
    if (!this.page) return 'unknown';
    const input = this.page.locator(this.sel.input).first();
    try {
      await input.waitFor({ state: 'visible', timeout: 20_000 });
      return 'ok';
    } catch {
      const loginBtn = await this.page
        .locator(this.sel.loginIndicator)
        .first()
        .isVisible()
        .catch(() => false);
      return loginBtn ? 'login' : 'unknown';
    }
  }

  /** 诊断：dump 页面上候选选择器的命中情况，页面改版时校准用 */
  async probe(): Promise<Record<string, unknown>> {
    if (!this.page) throw new Error('未连接');
    const out: Record<string, unknown> = { url: this.page.url() };
    const items: Array<{ selector: string; count: number }> = [];
    const add = (sel: string) => items.push({ selector: sel, count: 0 });
    const selectors = [this.sel.input, this.sel.assistantMessage, this.sel.loginIndicator, ...this.sel.newChatCandidates];
    for (const sel of selectors) add(sel);
    for (const item of items) {
      item.count = await this.page.locator(item.selector).count();
    }
    out['selectorHits'] = items;
    out['allTextareas'] = await this.page
      .locator('textarea')
      .evaluateAll((els) =>
        els.map((el) => ({ id: el.id, placeholder: (el as HTMLTextAreaElement).placeholder })),
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
      await this.page.keyboard.press('Enter'); // DeepSeek 用 Enter 发送（Shift+Enter 是换行）
      this.lastSentAt = Date.now();
      return { ok: true, value: undefined };
    } catch (e) {
      return this.fail('internal-error', e instanceof Error ? e.message : String(e), true);
    }
  }

  /** 清理 UI 按钮与工具标签文本残留 */
  private static sanitize(s: string): string {
    return s
      .split(/\r?\n/)
      .filter((line) => !/^(复制|下载|Copy|Download|深度思考|智能搜索|内容由 AI 生成，请仔细甄别)$/.test(line.trim()))
      .join('\n');
  }

  private async readAssistant(): Promise<{ count: number; lastText: string }> {
    if (!this.page) return { count: 0, lastText: '' };
    const blocks = this.page.locator(this.sel.assistantMessage);
    const count = await blocks.count().catch(() => 0);
    for (let i = count - 1; i >= Math.max(0, count - 3); i--) {
      const t = DeepSeekWebAdapter.sanitize(await blocks.nth(i).innerText().catch(() => ''));
      if (t.trim()) return { count, lastText: t };
    }
    return { count, lastText: '' };
  }

  /** 聊天内容区全文（含原生 DSML 输出的非 markdown 消息），供前缀差分提取新增内容 */
  async captureChatFingerprint(): Promise<string> {
    if (!this.page) return '';
    const area = this.page
      .locator('div.ds-scroll-area')
      .filter({ has: this.page.locator('div.ds-markdown') })
      .last();
    const text = (await area.innerText().catch(() => '')) || (await this.page.locator('body').innerText().catch(() => ''));
    return text;
  }

  /** 发送前快照，供 waitForResponse 识别"新增的"回复 */
  async snapshotBaseline(): Promise<number> {
    return (await this.readAssistant()).count;
  }

  async waitForResponse(
    opts: WaitForResponseOptions & { baselineChatFp?: string },
  ): Promise<AdapterResult<{ text: string; complete: boolean }>> {
    if (!this.page) return this.fail('not-connected', '尚未连接浏览器。');
    const deadline = Date.now() + opts.totalTimeoutMs;
    let domDeadline = deadline;
    // -------- 通道 0（首选）：网络响应流。SSE 的 FINISHED 是确定性完成信号，
    // 文本来自数据流本身，无渲染损伤（围栏/反引号不丢失），无 DOM 污染。
    const netBaseline = opts.netBaseline ?? -1;
    if (netBaseline >= 0 && !this.cdpFailed) {
      let lastNetText = '';
      let netStable = 0;
      while (Date.now() < deadline) {
        const fresh = this.rx.slice(netBaseline).filter((e) => e.text.trim());
        if (fresh.length > 0) {
          const entry = fresh[fresh.length - 1]!;
          if (entry.text === lastNetText) netStable += 1;
          else {
            netStable = 0;
            lastNetText = entry.text;
          }
          // FINISHED = 服务端明确宣告完成；或同一内容连续 N 次采样未变（保底）
          if ((entry.status && /FINISHED/.test(entry.status)) || netStable >= 2) {
            this.lastReceivedAt = Date.now();
            this.connectionState = 'connected';
            this.lastError = null;
            if (process.env['WEBAI_DEBUG'] === '1') {
              console.log(`[debug] net 通道命中：status=${entry.status} len=${entry.text.length}`);
            }
            return { ok: true, value: { text: entry.text, complete: true } };
          }
        }
        await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
      }
      // 网络通道总超时：给 DOM 通道一个宽限窗口，防止个别响应 body 丢失时完全失联
      if (this.rx.length <= netBaseline) {
        domDeadline = Date.now() + 90_000;
      }
    }
    // -------- 后备：DOM 计数 + 差分通道 --------
    let stable = 0;
    let lastText = '';
    let sawNewByCount = false;
    let sawNewByFp = false;
    const debug = process.env['WEBAI_DEBUG'] === '1';
    while (Date.now() < domDeadline) {
      const { count, lastText: txt } = await this.readAssistant();
      const fp = await this.captureChatFingerprint();
      if (count > opts.baselineAssistantCount) sawNewByCount = true;

      // 新增内容提取（重组感知差分），按优先级：
      // ① 全文前缀差分（理想：只追加不改写）
      // ② 包含差分（fp 含整个基线：新增文字在基线之后）
      // ③ 尾尾对齐最长公共后缀差分（DeepSeek 会折叠重组历史消息，但新增内容仍追加在尾部）
      // ④ 计数通道（ds-markdown 数增长时取最后一条）
      const baselineFp = opts.baselineChatFp ?? '';
      let delta = '';
      if (baselineFp && fp && fp.startsWith(baselineFp)) {
        delta = fp.slice(baselineFp.length);
      } else if (baselineFp && fp.includes(baselineFp)) {
        delta = fp.slice(fp.indexOf(baselineFp) + baselineFp.length);
      } else if (baselineFp && fp) {
        // 尾尾对齐：找最长公共后缀 k
        const maxK = Math.min(baselineFp.length, fp.length);
        let k = maxK;
        while (k > 0 && baselineFp.slice(-k) !== fp.slice(-k)) k--;
        delta = fp.slice(0, fp.length - k);
      } else if (count > opts.baselineAssistantCount) {
        delta = txt;
      }
      if (delta.trim()) sawNewByFp = true;
      if (debug) {
        const tailOk = baselineFp && fp.includes(baselineFp.slice(-600));
        console.log(
          `[debug] poll count=${count} fp=${fp.length}${baselineFp && fp.startsWith(baselineFp) ? ' prefix-ok' : ' prefix-X'}${tailOk ? ' tail-ok' : ' tail-X'} sawCount=${sawNewByCount} deltaLen=${delta.length}`,
        );
      }

      // 剔除本次发送的用户消息文本（渲染可能改空白：整段直查 / 压缩近似仅作标记用）
      const sentText = (opts.sentText ?? '').trim();
      if (sentText) {
        const idxRaw = delta.indexOf(sentText);
        if (idxRaw !== -1) {
          delta = delta.slice(idxRaw + sentText.length);
        } else {
          // 渲染改变空白时：只记录可见性，不做误切
          void sentText;
        }
      }
      if (delta.trim()) sawNewByFp = true;
      if (debug) {
        const tailOk = baselineFp && fp.includes(baselineFp.slice(-600));
        console.log(
          `[debug] poll count=${count} fp=${fp.length}${baselineFp && fp.startsWith(baselineFp) ? ' prefix-ok' : ' prefix-X'}${tailOk ? ' tail-ok' : ' tail-X'} sawCount=${sawNewByCount} deltaLen=${delta.length}`,
        );
      }

      // 候选回复文本：优先新增差分（不含历史，且从最后一个 assistant 标记切尾以隔离
      // 提示词里的协议示例文本），否则退回最后一条 markdown 块。
      let candidate = '';
      if (delta.trim()) {
        const markers = ['\u27E6TOOLCALL\u27E7', '<finish>', '<\uFF5C\uFF5CDSML'];
        let lastIdx = -1;
        for (const mk of markers) {
          const i = delta.lastIndexOf(mk);
          if (i !== -1 && i > lastIdx) lastIdx = i;
        }
        if (lastIdx >= 0) {
          candidate = DeepSeekWebAdapter.sanitize(delta.slice(lastIdx));
        }
      } else if (sawNewByCount && txt.trim()) {
        candidate = DeepSeekWebAdapter.sanitize(txt);
      }
      if (sawNewByCount || sawNewByFp) {
        const rejected = (opts.rejectPatterns ?? []).find((p) => candidate.includes(p));
        if (rejected) {
          return this.fail('rejected-by-site', `回复命中受限关键词：${rejected}`);
        }
        if (candidate && candidate === lastText) {
          stable += 1;
          if (stable >= opts.stablePolls) {
            this.lastReceivedAt = Date.now();
            this.connectionState = 'connected';
            this.lastError = null;
            return { ok: true, value: { text: candidate, complete: true } };
          }
        } else {
          stable = 0;
        }
      }
      lastText = candidate;
      await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
    }
    if (sawNewByCount || sawNewByFp) {
      // 有新内容但未收敛：疑似流式输出被中断/超时
      return this.fail(
        'truncated-suspected',
        `响应未在时限内稳定（最后候选内容长度 ${lastText.length}），可能流式未完成。`,
        true,
      );
    }
    return this.fail('timeout', `在 ${opts.totalTimeoutMs}ms 内未收到新增回复。`, true);
  }

  async getConversationState(): Promise<WebConversationState> {
    if (!this.page) throw new Error('未连接');
    const url = this.page.url();
    const m = url.match(/\/(?:c|s)\/([0-9a-f-]{8,})/i) ?? url.match(/\/a\/chat\/s\/([0-9a-f-]{8,})/i);
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
    let clicked = false;
    for (const c of this.sel.newChatCandidates) {
      const btn = this.page.locator(c).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // 兜底①：点击最内层含“开启新对话”文本的元素（类名哈希混淆，无法用 class 定位）
      const ok = await this.page.evaluate(`(() => {
        const targets = [...document.querySelectorAll('div, span, button')]
          .filter((el) => el.children.length === 0 && (el.textContent || '').trim() === ${JSON.stringify('开启新对话')});
        if (targets.length > 0) { targets[0].click(); return true; }
        return false;
      })()`);
      if (!ok) {
        // 兜底②：回到站点根（可能显示上一个会话，忠实报告该限制）
        await this.page.goto(this.cfg.startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        return this.fail(
          'page-structure-changed',
          '未找到"新建会话"入口，已回退打开站点首页；请运行 probe 校准选择器。',
          false,
        );
      }
    }
    // 等待回到无会话页（conversationId 为空）
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await this.getConversationState().catch(() => null);
      if (st && st.conversationId === null) return { ok: true, value: undefined };
    }
    return { ok: true, value: undefined };
  }

  async recoverConversation(
    state: WebConversationState,
  ): Promise<AdapterResult<WebConversationState>> {
    if (!this.page) return this.fail('not-connected', '尚未连接浏览器。');
    try {
      if (state.conversationId && state.url) {
        await this.page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } else {
        await this.page.goto(this.cfg.startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      const st = await this.getConversationState();
      return { ok: true, value: st };
    } catch (e) {
      return this.fail('internal-error', e instanceof Error ? e.message : String(e), true);
    }
  }

  async disconnect(): Promise<void> {
    // 仅解除附加，不关闭用户的专用 Edge 实例（保留登录态）
    this.page = null;
    this.connectionState = 'disconnected';
  }
}
