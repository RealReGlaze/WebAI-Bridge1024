/**
 * Agent 自动迭代循环。
 *
 * 流程：任务目标 → 系统消息（协议+工具说明）→ 发给网页模型 → 解析回复/调用块
 *   → 本地执行工具（沙箱+白名单+人工确认）→ 结果回传 → 循环
 * 停止条件：<finish> / 显式轮数上限（默认不设，模型自主推进） / 连续无新进展停滞停机 / 重复失败调用检测 / 网页侧失败。
 *
 * 每轮任务状态持久化到 .runtime/tasks/<sessionId>.json，供恢复与跨模型交接。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { IModelAdapter, type WaitForResponseOptions, type WebConversationState, type ChatTurn } from '../adapters/IModelAdapter.js';
import { defaultTools, type Tool, type ToolContext, type ToolOutput } from '../tools/index.js';
import { loadPolicy, POLICY_FILENAME, type AgentPolicy } from '../tools/policy.js';
import {
  buildRetryMessage,
  buildSystemMessage,
  buildToolResultMessage,
  parseReply,
} from '../protocol.js';

export interface AgentLoopOptions {
  goal: string;
  workspaceRoot: string;
  maxRounds?: number | null;
  /** 停滞停机线：连续这么多轮「无任何新执行的工具调用」则判定停滞（默认 8；仅无上限模式生效） */
  maxStallRounds?: number;
  waitFor: WaitForResponseOptions & { rejectPatterns?: string[] };
  autoApprove: boolean;
  /** 停止钩子（CLI 的 stop signal） */
  shouldStop?: () => boolean;
  /** 续跑：注入已保存的会话状态（transcript/进度/已执行签名），从中断点继续 */
  resumeSession?: AgentSessionState;
  /** 前情摘要：全新网页对话的首条消息附加（跨对话/跨模型接力，来自 CLI 滚动摘要库） */
  contextDigest?: string;
  /** 轮间节流（防风控）：每轮发送前等待的毫秒数（/wait <seconds> 设置） */
  pacingMs?: number;
  /** 深度思考开关：connect 后立刻设置（undefined = 不动网页上的开关）；开启时思考更久，轮次时限自动放大 */
  deepThink?: boolean;
  /** 审批模型：--yes/auto 放行时由「另一个模型」审批允许/拒绝（例：mimo 推理时由 deepseek 审批） */
  approver?: { adapter: IModelAdapter; label: string };
}

export interface AgentRoundLog {
  round: number;
  sentChars: number;
  replyChars: number;
  /** ok 状态下记录 digest 与输出片段：供 CLI 展示与续跑重建上下文 */
  calls: Array<{ name: string; ok: boolean; digest?: string; output?: string }>;
  finish: string | null;
  error?: string;
  /** 本轮模型侧思考过程摘录（页面提供时才有；跨模型交接时随进展一并移交） */
  thinking?: string;
}

export interface AgentSessionState {
  sessionId: string;
  goal: string;
  workspaceRoot: string;
  adapterId: string;
  status: 'running' | 'finished' | 'failed' | 'stopped';
  startedAt: number;
  updatedAt: number;
  rounds: AgentRoundLog[];
  conversation: WebConversationState | null;
  transcript: ChatTurn[];
  /** 已真实执行过的调用签名（防止续跑时重放；与内存 executedKeys 同步落盘） */
  executedKeys: string[];
  summary?: string;
}

export class AgentLoop {
  private adapter: IModelAdapter;
  private options: AgentLoopOptions;
  private session: AgentSessionState;
  private policy: AgentPolicy;
  /** 已执行过的调用签名（防重放） */
  private executedKeys = new Set<string>();

  get sessionId(): string {
    return this.session.sessionId;
  }

  constructor(adapter: IModelAdapter, options: AgentLoopOptions) {
    this.adapter = adapter;
    this.options = options;
    this.policy = loadPolicy(options.workspaceRoot);
    const resumed = options.resumeSession ?? null;
    this.executedKeys = new Set(resumed?.executedKeys ?? []);
    this.session = resumed
      ? {
          ...resumed,
          status: 'running',
          summary: undefined,
          updatedAt: Date.now(),
        }
      : {
          sessionId: `t${Date.now().toString(36)}`,
          goal: options.goal,
          workspaceRoot: options.workspaceRoot,
          adapterId: adapter.backendId,
          status: 'running',
          startedAt: Date.now(),
          updatedAt: Date.now(),
          rounds: [],
          conversation: null,
          transcript: [],
          executedKeys: [],
        };
  }

  private saveSession(): void {
    const dir = path.resolve(process.cwd(), '.runtime', 'tasks');
    mkdirSync(dir, { recursive: true });
    this.session.updatedAt = Date.now();
    this.session.executedKeys = [...this.executedKeys];
    const target = path.join(dir, `${this.session.sessionId}.json`);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.session, null, 2), 'utf-8');
    renameSync(temp, target);
  }

  /** 审批模型是否不可用（连接失败等，回退为直接放行；进程内记忆避免反复重试） */
  private approverUnavailable = false;

  /** 深度思考开关是否成功置于开启（成功后轮次等待时限 ×3） */
  private deepThinkApplied = false;

  /** 高风险操作确认：CLI 人工 y/n，或自动放行（有审批模型时交给它 Allow/Refuse） */
  private makeToolContext(): ToolContext {
    return {
      workspaceRoot: this.options.workspaceRoot,
      policy: this.policy,
      skipConfirm: true,
      confirm: async (title: string, detail?: string) => {
        if (this.options.autoApprove) {
          return this.approve(title, detail);
        }
        const answer = await confirmPrompt(`[确认] ${title}? (y/N) `);
        return answer;
      },
    };
  }

  /** 自动放行：优先交由审批模型；审批模型不可用时拒绝高风险操作。 */
  private async approve(title: string, detail?: string): Promise<boolean> {
    const ap = this.options.approver;
    if (!ap || this.approverUnavailable) {
      console.log(`[agent] 自动审批不可用，拒绝高风险操作：${title.split('\n')[0]}`);
      return false;
    }
    const verdict = await this.modelApproval(ap, title, detail);
    if (verdict === null) {
      this.approverUnavailable = true;
      console.log(`[agent] 审批模型不可用：拒绝高风险操作（${title.split('\n')[0]}）`);
      return false;
    }
    return verdict;
  }

  /** 调用审批模型：发送任务背景 + 操作摘要 + 操作原始内容，要求第一行 Allow/Refuse、第二行理由。遵守 /wait 节流。 */
  private async modelApproval(ap: { adapter: IModelAdapter; label: string }, title: string, detail?: string): Promise<boolean | null> {
    // 节流遵循 /wait 设置（审批对话与任务轮次共用）
    if (this.options.pacingMs && this.options.pacingMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.pacingMs));
    }
    const conn = await ap.adapter.connect();
    if (!conn.ok) return null;
    const recent = this.session.rounds.slice(-2).flatMap((r) => r.calls);
    const recentText = recent.length
      ? recent.map((c) => `${c.name}${c.ok ? '✓' : '✗'}`).join('、')
      : '（本轮首批操作）';
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，原始长度 ${s.length} 字符）` : s);
    const msg = [
      '你是本地 Agent 系统的安全审批员。执行方模型请求批准下列操作，操作的全部原始内容附在下方（文件补丁的 SEARCH/REPLACE 原文、完整命令行等），请依据内容本身做出判断。',
      '',
      `【任务目标】${(this.options.goal ?? '').replace(/\s+/g, ' ').slice(0, 200)}`,
      `【工作区（仅此目录允许改动）】${this.options.workspaceRoot}`,
      `【最近已执行】${recentText}`,
      `【本次待批操作】${title}`,
      ...(detail ? [`【操作原始内容】\n${cut(detail, 1800)}`] : ['【无附加原始内容】']),
      '',
      '审批依据：越出工作区之外、删除性/不可逆破坏（删除大量文件、git push/重置等）、危险系统变更、明显与任务目标无关的操作 → Refuse；与目标相干的正当改动一并给出理由。',
      '回复格式要求：第一行只写 Allow（允许）或 Refuse（拒绝）；第二行写一句理由（不超过 40 字）。不要输出其他内容。',
    ].join('\n');
    const sent = await ap.adapter.sendMessage(msg);
    if (!sent.ok) return null;
    const baseline = await ap.adapter.snapshotBaseline().catch(() => 0);
    const nb = (await ap.adapter.captureNetBaseline().catch(() => -1)) ?? -1;
    const wait = await ap.adapter.waitForResponse({
      baselineAssistantCount: baseline,
      netBaseline: nb,
      totalTimeoutMs: 90_000,
      stablePolls: 3,
      pollIntervalMs: 800,
    });
    const raw = wait.ok ? wait.value.text : `（审批模型 ${wait.code}：${wait.message}）`;
    const firstLine = raw.trim().split(/\r?\n/, 1)[0]!.replace(/^[#>*\s-]+/, '').replace(/\*+/g, '').trim();
    const allow = /^(allow|允许|同意|approve)\b/i.test(firstLine);
    const refuse = /^(refuse|拒绝|deny|否)\b/i.test(firstLine);
    const reason = raw.trim().split(/\r?\n/).slice(1).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '（未给出理由）';
    if (!allow && !refuse) {
      console.log(`[审批] ${ap.label}：输出无法解析（首行「${firstLine.slice(0, 30)}」），按拒绝处理。`);
      return false;
    }
    console.log(`[审批] ${ap.label} → ${allow ? 'Allow（允许）' : 'Refuse（拒绝）'}｜理由：${reason}`);
    return allow;
  }

  private async runToolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<Array<{ name: string; result: ToolOutput }>> {
    const ctx = this.makeToolContext();
    const tools = defaultTools;
    const results: Array<{ name: string; result: ToolOutput }> = [];
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        results.push({ name: call.name, result: { ok: false, output: '内部错误：未知工具', rejected: true } });
        continue;
      }
      try {
        if (tool.confirmHint) {
          const hint = tool.confirmHint(call.args, ctx);
          if (hint) {
            // 原始内容：单一长字符串参数直接用原文（补丁/命令行），否则给参数 JSON（供审批模型判断）
            const stringParam = tool.params.find(
              (p) => p.type === 'string' && typeof call.args[p.name] === 'string' && (call.args[p.name] as string).length > 0,
            );
            const detail = stringParam ? (call.args[stringParam.name] as string) : JSON.stringify(call.args, null, 1);
            const ok = await ctx.confirm(hint, detail);
            if (!ok) {
              results.push({ name: tool.name, result: { ok: false, output: '未获批准（人工或审批模型拒绝）：该写操作未执行。如需修改，请依据拒绝原因调整后再次提交。', rejected: true } });
              continue;
            }
          }
        }
        const result = await tool.execute(call.args, ctx);
        results.push({ name: tool.name, result });
      } catch (e) {
        results.push({ name: tool.name, result: { ok: false, output: `工具执行异常：${e instanceof Error ? e.message : String(e)}`, rejected: false } });
      }
    }
    return results;
  }

  /** 循环检测：连续多轮同一组工具全部失败 → 强制停止；协议类错误连续 5 次 → 强制停止 */
  private detectLoop(): string | null {
    const failedRounds = this.session.rounds.filter((r) => r.calls.length > 0 && r.calls.every((c) => !c.ok));
    const keys = failedRounds.slice(-6).map((r) => JSON.stringify(r.calls.map((c) => c.name)));
    if (keys.length >= 4 && keys.every((k) => k === keys[0])) return '连续多轮同一组工具全部失败，判定为重复失败循环，已停止。';
    const protocolFails = this.session.rounds.filter((r) => r.error?.startsWith('协议')).length;
    if (protocolFails >= 5) return '协议校验连续失败 5 次，已停止。';
    return null;
  }

  async run(): Promise<AgentSessionState> {
    const { options } = this;
    const resumed = options.resumeSession ?? null;
    if (resumed && resumed.status === 'finished') {
      this.session.summary = resumed.summary;
      this.session.status = 'finished';
      return this.session; // 无需任何操作
    }
    const startRound = this.session.rounds.length;
    const conn = await this.adapter.connect();
    if (!conn.ok) {
      this.session.status = 'failed';
      this.session.summary = `连接失败：${conn.code} ${conn.message}`;
      this.saveSession();
      return this.session;
    }
    if (options.deepThink !== undefined) {
      const toggled = await this.adapter.setDeepThink(options.deepThink);
      this.deepThinkApplied = toggled && options.deepThink === true;
      if (!toggled) console.log(`[agent] 后端 ${this.adapter.backendId} 未提供深度思考开关（跳过）。`);
    }
    // 每次运行都从新网页会话开始（续跑的新上下文由第一条消息重建，避免残留干扰）
    const fresh = await this.adapter.startNewConversation();
    if (!fresh.ok) {
      this.session.status = 'failed';
      this.session.summary = `新建会话失败：${fresh.code} ${fresh.message}`;
      this.saveSession();
      return this.session;
    }

    const systemMsg = buildSystemMessage(options.goal, options.workspaceRoot);
    let message = resumed ? buildResumeMessage(this.session, this.adapter.backendId) : systemMsg;
    if (resumed) {
      // 交接完成后记录当前执行后端（供下一次续跑/交接继续追溯）
      this.session.adapterId = this.adapter.backendId;
      this.saveSession();
    } else if (options.contextDigest && options.contextDigest.trim()) {
      // 全新网页对话：注入前情摘要（跨对话/跨模型接力的滚动记忆）
      message += [
        '',
        '# 前情摘要（由之前任务接力；工具结果均来自本地真实执行，可信）',
        options.contextDigest.trim(),
        '',
        '以上为接力记忆：可直接吸收，但涉及本地文件当前状态时先用工具核实再行动。',
      ].join('\n');
    }

    // 动态轮数预算：默认不设硬上限（模型自主推进，直到 <finish> / 手动停止 / 停滞停机）；
    // 显式 maxRounds>0 才作为硬上限。ask 模式（模型自声明快问快答）收缩到 3 轮。
    // 安全网：连续 maxStallRounds 轮「无任何新执行的工具调用」（协议重试/重复调用/无调用块）→ 判定停滞停机。
    let remaining = (options.maxRounds ?? 0) > 0 ? (options.maxRounds as number) : Infinity;
    let stallCount = 0;
    const stallLimit = options.maxStallRounds ?? 8;
    let round = startRound;
    for (;;) {
      if (options.shouldStop?.()) {
        this.session.status = 'stopped';
        this.session.summary = '用户手动停止。';
        this.saveSession();
        return this.session;
      }
      if (!isFinite(remaining) && stallCount >= stallLimit) {
        // 无上限模式下唯一停机线：连续多轮无新进展（协议重试/重复调用/只评论不行动）
        this.session.status = 'failed';
        this.session.summary = `连续 ${stallCount} 轮无新进展，判定停滞已停机（可用 /continue 换个路径继续或人工接手）。`;
        this.saveSession();
        console.log(`[agent] 连续 ${stallCount} 轮无新进展，已停滞停机。`);
        return this.session;
      }
      if (remaining <= 0) {
        this.session.status = 'failed';
        this.session.summary = `达到最大轮数 ${this.session.rounds.length - startRound}。`;
        this.saveSession();
        console.log(`[agent] 总结轨迹：达到本轮预算上限。`);
        return this.session;
      }
      remaining--;
      round++;
      // 轮间节流（防风控）：每轮发送前等待 pacingMs
      if (options.pacingMs && options.pacingMs > 0) {
        console.log(`[agent] 节流等待 ${Math.round(options.pacingMs / 1000)}s 后发送本轮消息…`);
        await new Promise((r) => setTimeout(r, options.pacingMs));
      }
      const snap = (await this.adapter.getConversationState()).assistantMessageCount;
      const chatFp = await this.adapter.captureChatFingerprint();
      const netBaseline = await this.adapter.captureNetBaseline();
      const sent = await this.adapter.sendMessage(message);
      if (!sent.ok) {
        // 网页限流/登录过期等：保存状态并停止（第六阶段引入跨模型切换）
        this.session.status = 'failed';
        this.session.summary = `发送失败：${sent.code} ${sent.message}`;
        this.saveSession();
        return this.session;
      }
      // 深度思考轮次：思考链可能远超普通回复，等待时限自动放大（防「长思考时提前收卷」）
      const deepFactor = options.deepThink === true && this.deepThinkApplied ? 3 : 1;
      const reply = await this.adapter.waitForResponse({
        ...options.waitFor,
        totalTimeoutMs: Math.round(options.waitFor.totalTimeoutMs * deepFactor),
        minStableMs: this.deepThinkApplied ? 3000 : undefined,
        baselineAssistantCount: snap,
        baselineChatFp: chatFp,
        netBaseline,
        sentText: message,
      });
      this.session.conversation = await this.adapter.getConversationState().catch(() => null);
      if (!reply.ok) {
        this.session.status = 'failed';
        this.session.summary = `等待回复失败：${reply.code} ${reply.message}`;
        this.saveSession();
        return this.session;
      }
      const text = reply.value.text.replace(/^回[复答][:：]/, '').trim();
      const thinking = (reply.value.thinking ?? '').trim();
      this.session.transcript.push({ role: 'user', text: message, timestamp: Date.now() });
      this.session.transcript.push({ role: 'assistant', text, thinking: thinking || undefined, timestamp: Date.now() });

      const parsed = parseReply(text);
      // 模式自声明：ask 快问快答 → 收缩剩余轮数预算
      if (parsed.mode === 'ask') remaining = Math.min(remaining, 3);
      // 防重放：已经在本地真实执行过的调用签名直接跳过（登记发生在执行之后）
      const freshCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      for (const c of parsed.calls) {
        const key = `${c.name}::${JSON.stringify(c.args)}`;
        if (this.executedKeys.has(key)) continue;
        freshCalls.push(c);
      }
      const log: AgentRoundLog = {
        round,
        sentChars: message.length,
        replyChars: text.length,
        calls: [],
        finish: parsed.finish,
        thinking: thinking || undefined,
      };

      if (parsed.errors.length > 0 && freshCalls.length === 0) {
        log.error = `协议${parsed.errors.length}项`;
        message = buildRetryMessage(parsed.errors);
        this.session.rounds.push(log);
        this.saveSession();
        stallCount++;
        console.log(`[agent] 第 ${round} 轮：协议校验失败 x${parsed.errors.length}，已要求重发。`);
        continue;
      }

      if (freshCalls.length === 0 && parsed.calls.length > 0) {
        // 全部是重放调用：明确告知，要求推进而不是重复提交
        log.error = '重复调用';
        message =
          '以上调用块此前已经执行过（结果见更早的 <tool_result>），本地未重复执行。请基于已有结果给出下一步：新的调用块，或 <finish>。不要重复提交同样的请求。';
        this.session.rounds.push(log);
        this.saveSession();
        stallCount++;
        continue;
      }

      if (freshCalls.length === 0) {
        if (parsed.finish) {
          log.finish = parsed.finish;
          this.session.rounds.push(log);
          this.session.status = 'finished';
          this.session.summary = parsed.finish;
          this.saveSession();
          console.log(`[agent] 第 ${round} 轮：任务完成。`);
          return this.session;
        }
        // 无调用也无 finish：可能模型在闲聊；要求按协议行动
        log.error = '无调用块';
        message =
          '请使用协议继续：要么输出调用块执行下一步操作，要么输出 <finish>总结</finish> 结束任务。不要只发表评论。';
        this.session.rounds.push(log);
        this.saveSession();
        stallCount++;
        continue;
      }

      const results = await this.runToolCalls(freshCalls);
      for (const c of freshCalls) {
        this.executedKeys.add(`${c.name}::${JSON.stringify(c.args)}`);
      }
      stallCount = 0; // 本轮有新执行的工具调用 → 进展正常，重置停滞计数
      log.calls = results.map((r, i) => ({
        name: r.name,
        ok: r.result.ok,
        digest: digestOfArgs(freshCalls[i]?.args),
        output: toolResultSnippet(r.result.output),
      }));
      this.session.rounds.push(log);
      this.saveSession();
      for (const c of log.calls) {
        console.log(`[agent] 第 ${round} 轮 ● ${c.name}${c.digest ? ` "${c.digest}"` : ''} → ${c.ok ? '✓' : '✗'}`);
      }

      const loop = this.detectLoop();
      if (loop) {
        this.session.status = 'failed';
        this.session.summary = loop;
        this.saveSession();
        return this.session;
      }

      if (parsed.finish) {
        log.finish = parsed.finish;
        const anyOk = this.session.rounds.some((r) => r.calls.some((c) => c.ok));
        this.session.status = anyOk ? 'finished' : 'failed';
        this.session.summary = parsed.finish;
        this.saveSession();
        console.log(anyOk ? `[agent] 第 ${round} 轮：任务完成。` : `[agent] 第 ${round} 轮：模型放弃且无成功操作，记为失败。`);
        return this.session;
      }

      message = buildToolResultMessage(results);
      if (parsed.errors.length > 0) {
        // 有效调用已执行；同时告知哪几个片段无效（例如提示词示例被误算）
        message += `\n\n另注：本次回复中以下片段协议校验失败，未执行（若非你本意的调用可忽略本条；若是你的调用请重发完整块）：\n${parsed.errors.join('\n')}`;
      }
    }
  }
}

/** 进程级单排行队列：stdin 只由一个 readline 接口持有，行写入队列；读取方按序取行。
 *  REPL 的 >> 输入与工具 y/N 确认共用此队列（修复：多接口下管道 EOF 抢先 close、确认无法输入的问题）。 */
let rlSingleton: ReturnType<typeof createInterface> | null = null;
/** 等待下一行的读取方（同一时刻至多一个：REPL 输入或工具确认） */
let waiter: ((l: string | null) => void) | null = null;
/** 是否已读到流结束（真管道 EOF / Ctrl+C）；之后的读取立即返回 null */
let stdinExhausted = false;
/** 先于读取方到达的行缓冲 */
const queuedLines: string[] = [];

function ensureStdinReader(): void {
  if (rlSingleton) return;
  rlSingleton = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  rlSingleton.on('line', (l: string) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(l);
    } else {
      queuedLines.push(l);
    }
  });
  rlSingleton.on('close', () => {
    stdinExhausted = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
}

/** 清空缓冲的未消费行（REPL 任务结束后调用：上一个任务的 y/n 残留不再作为新目标） */
export function clearQueuedLines(): void {
  queuedLines.length = 0;
}

/** 一次性行读取：REPL 的 >> 输入与工具 y/N 确认共用。EOF/Ctrl+C 返回 null。 */
export function readLineOnce(q: string): Promise<string | null> {
  ensureStdinReader();
  const queued = queuedLines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (stdinExhausted) return Promise.resolve(null);
  return new Promise((resolve) => {
    waiter = resolve;
    process.stdout.write(q);
  });
}

/** 工具确认 y/N：从同一 stdin 行队列读取（修复交互模式下确认无法输入的问题） */
async function confirmPrompt(q: string): Promise<boolean> {
  const answer = await readLineOnce(q);
  return !!answer && /^\s*y(es)?\s*$/i.test(answer);
}

/** 会话滚动摘要（供 CLI 跨对话/跨模型接力）：每轮浓缩为 思考/回复/工具 三段短摘 + 终态。 */
export function summarizeSessionDigest(session: AgentSessionState): string {
  const cur = (s: string | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines: string[] = [`【目标】${cur(session.goal, 120)}`];
  // 每个有日志的轮次都恰好收到过一条助手回复（发送失败会直接中止，不入轮次），
  // 故 transcript 中 assistant 条目按序与本轮次数组一一对应。
  const assistantTurns = session.transcript.filter((x) => x.role === 'assistant');
  for (let i = 0; i < session.rounds.length; i++) {
    const r = session.rounds[i]!;
    const tools = r.calls.length
      ? r.calls.map((c) => `${c.name}${c.digest ? `(${c.digest})` : ''}${c.ok ? '✓' : '✗'}`).join('，')
      : `提示：${r.error ?? '-'}`;
    const parts = [`第${r.round}轮 工具: ${tools}`];
    if (r.thinking) parts.push(`思考: ${cur(r.thinking, 180)}`);
    const t = assistantTurns[i];
    if (t?.text) parts.push(`回复: ${cur(t.text, 260)}`);
    lines.push('- ' + parts.join('｜'));
  }
  lines.push(`【终态】${session.status}${session.summary ? `：${cur(session.summary, 120)}` : ''}`);
  return lines.join('\n');
}

/** 调用参数的简短摘要（日志/续跑上下文用）：优先人类可读键 */
export function digestOfArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const cmd = typeof args['command'] === 'string' ? args['command'] : '';
  if (cmd.trim()) return cmd.replace(/\s+/g, ' ').slice(0, 60);
  const p = typeof args['path'] === 'string' ? args['path'] : '';
  if (p.trim()) return p.replace(/\s+/g, ' ').slice(0, 60);
  const q = typeof args['query'] === 'string' ? args['query'] : '';
  if (q.trim()) return q.replace(/\s+/g, ' ').slice(0, 60);
  const patch = typeof args['patch'] === 'string' ? args['patch'] : '';
  if (patch.trim()) {
    // 补丁摘要：目标路径 + 动作（新建/修改）
    const firstLine = patch.split('\n')[0]?.trim() ?? '';
    const creating = /=======\s*\n+=======/.test(patch.split('\n').slice(1, 4).join('\n'));
    return `${firstLine.replace(/^path:\s*/, 'path:')}（${creating ? '新建' : '修改'}）`.slice(0, 80);
  }
  return JSON.stringify(args)
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

/** 工具输出片段（续跑上下文用）：压平空白并截断 */
export function toolResultSnippet(output: string): string {
  const t = output.replace(/\r\n/g, '\n').trim().replace(/\n{3,}/g, '\n\n');
  return t.length > 300 ? `${t.slice(0, 300)}\n…[截断，共 ${t.length} 字符]` : t;
}

/** 跨模型交接 / 续跑首条消息（协议说明 + 已执行进展 + 助手回复/思考摘录）。
 *  currentBackendId ≠ 原会话后端时输出「跨模型交接」段：显式告知模型换了执行方，
 *  并移交此前模型的回复与思考管道，防止浏览器端会话（原网页对话）丢失导致上下文断链。 */
export function buildResumeMessage(session: AgentSessionState, currentBackendId = ''): string {
  const progress: Array<{ round: number; line: string; output?: string; thinking?: string }> = [];
  const finish = session.summary && session.status !== 'running' ? session.summary : null;
  for (const r of session.rounds) {
    if (r.calls.length > 0) {
      const line = r.calls.map((c) => `${c.name}(${c.digest ?? ''})→${c.ok ? 'ok' : 'fail'}`).join('；');
      progress.push({
        round: r.round,
        line,
        output: r.calls.find((c) => !c.ok)?.output ?? r.calls[0]?.output,
        thinking: r.thinking,
      });
    } else if (r.error) {
      progress.push({ round: r.round, line: `（未执行：${r.error}）`, thinking: r.thinking });
    }
  }
  const crossModel = !!currentBackendId && session.adapterId !== currentBackendId;
  const base = buildSystemMessage(session.goal, session.workspaceRoot);
  const tail = finish ? `\n\n上一轮结束时声明：<finish>${finish}</finish>（若工作尚未真正完成请继续完成并重新 <finish>）` : '';

  const head = crossModel
    ? [
        '',
        '# 跨模型交接',
        `该任务此前由后端「${session.adapterId}」处理；本次由「${currentBackendId}」接手。原网页会话不跨后端保留，本消息即全部交接内容。`,
        '以下已执行进展与此前模型的回复/思考摘录均已核实过（工具结果来自本地真实执行，可信）。',
      ]
    : ['', '# 续跑说明', '这是一个此前中断任务（超时/轮数耗尽/手动停止）的续跑。网页端对话历史不保留，以下是已执行进展摘要：'];

  // 助手回复/思考摘录（跨模型时完整提供；同后端续跑也附思考摘录，帮助找回推理线索）
  const assistantExcerpts = session.transcript
    .filter((t) => t.role === 'assistant' && ((crossModel && t.text.trim()) || t.thinking))
    .slice(-8)
    .map((t, i) => {
      const txt = t.text.trim().slice(0, crossModel ? 400 : 160);
      const think = t.thinking ? `\n  思考片段：${t.thinking.replace(/\s+/g, ' ').slice(0, 300)}` : '';
      return `- （此前第 ${i + 1} 条回复）${txt}${think}`;
    })
    .join('\n');

  return [
    base,
    ...head,
    progress
      .map(
        (p) =>
          `- 第${p.round}轮 ${p.line}${p.output ? `；输出片段：${p.output}` : ''}${p.thinking ? `；思考片段：${p.thinking.replace(/\s+/g, ' ').slice(0, 240)}` : ''}`,
      )
      .join('\n') || '（尚无已执行步骤）',
    assistantExcerpts ? ['此前助手回复/思考摘录：', assistantExcerpts, ''].join('\n') : '',
    '本地文件系统的真实状态可能比上述摘要更新；不确定时用 list_files / read_file 重新确认，再继续未完成部分。',
    '已成功执行过的调用不会重复执行（重复提交会被识别为重放）。不要重复已完成步骤，直接推进剩余工作；达成目标后以 <finish>总结</finish> 收尾。',
    tail,
  ]
    .filter((s) => s !== '')
    .join('\n');
}

export { POLICY_FILENAME };
