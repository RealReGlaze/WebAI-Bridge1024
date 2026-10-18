/**
 * Agent 自动迭代循环。
 *
 * 流程：任务目标 → 系统消息（协议+工具说明）→ 发给网页模型 → 解析回复/调用块
 *   → 本地执行工具（沙箱+白名单+人工确认）→ 结果回传 → 循环
 * 停止条件：<finish> / 最大轮数 / 协议连续失败 / 重复失败调用检测 / 网页侧失败。
 *
 * 每轮任务状态持久化到 .runtime/tasks/<sessionId>.json，供恢复与跨模型交接。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
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
  maxRounds: number;
  waitFor: WaitForResponseOptions & { rejectPatterns?: string[] };
  autoApprove: boolean;
  /** 停止钩子（CLI 的 stop signal） */
  shouldStop?: () => boolean;
}

export interface AgentRoundLog {
  round: number;
  sentChars: number;
  replyChars: number;
  calls: Array<{ name: string; ok: boolean }>;
  finish: string | null;
  error?: string;
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
    this.session = {
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
    };
  }

  private saveSession(): void {
    const dir = path.resolve(process.cwd(), '.runtime', 'tasks');
    mkdirSync(dir, { recursive: true });
    this.session.updatedAt = Date.now();
    writeFileSync(path.join(dir, `${this.session.sessionId}.json`), JSON.stringify(this.session, null, 2), 'utf-8');
  }

  /** 高风险操作确认：CLI 人工 y/n，或 --yes 自动放行 */
  private makeToolContext(): ToolContext {
    return {
      workspaceRoot: this.options.workspaceRoot,
      policy: this.policy,
      confirm: async (title: string) => {
        if (this.options.autoApprove) {
          console.log(`[agent] 自动放行（--yes）：${title}`);
          return true;
        }
        const answer = await confirmPrompt(`[确认] ${title}? (y/N) `);
        return answer;
      },
    };
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
          const hint = tool.confirmHint(call.args);
          if (hint) {
            const ok = await ctx.confirm(hint);
            if (!ok) {
              results.push({ name: tool.name, result: { ok: false, output: '人工确认被拒绝：该写操作未执行。如需修改，请先说明理由再次提交。', rejected: true } });
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
    const conn = await this.adapter.connect();
    if (!conn.ok) {
      this.session.status = 'failed';
      this.session.summary = `连接失败：${conn.code} ${conn.message}`;
      this.saveSession();
      return this.session;
    }
    // 每次任务从新会话开始（避免上一任务的对话残留干扰）
    await this.adapter.startNewConversation();

    const systemMsg = buildSystemMessage(options.goal, options.workspaceRoot);
    let message = systemMsg;

    for (let round = 1; round <= options.maxRounds; round++) {
      if (options.shouldStop?.()) {
        this.session.status = 'stopped';
        this.session.summary = '用户手动停止。';
        this.saveSession();
        return this.session;
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
      const reply = await this.adapter.waitForResponse({
        ...options.waitFor,
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
      this.session.transcript.push({ role: 'user', text: message, timestamp: Date.now() });
      this.session.transcript.push({ role: 'assistant', text, timestamp: Date.now() });

      const parsed = parseReply(text);
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
      };

      if (parsed.errors.length > 0 && freshCalls.length === 0) {
        log.error = `协议${parsed.errors.length}项`;
        message = buildRetryMessage(parsed.errors);
        this.session.rounds.push(log);
        this.saveSession();
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
        continue;
      }

      const results = await this.runToolCalls(freshCalls);
      for (const c of freshCalls) {
        this.executedKeys.add(`${c.name}::${JSON.stringify(c.args)}`);
      }
      log.calls = results.map((r) => ({ name: r.name, ok: r.result.ok }));
      this.session.rounds.push(log);
      this.saveSession();
      console.log(
        `[agent] 第 ${round} 轮：执行 ${results.map((r) => `${r.name}(${r.result.ok ? 'ok' : 'fail'})`).join(' ')}`,
      );

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

    this.session.status = 'failed';
    this.session.summary = `达到最大轮数 ${options.maxRounds}。`;
    this.saveSession();
    return this.session;
  }
}

/** CLI y/n 确认（readline） */
function confirmPrompt(q: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(q);
    let data = '';
    const onData = (d: Buffer) => {
      data += d.toString();
      if (data.includes('\n')) {
        process.stdin.removeListener('data', onData);
        resolve(/^\s*y(es)?\s*$/i.test(data));
      }
    };
    process.stdin.on('data', onData);
  });
}

export { POLICY_FILENAME };
