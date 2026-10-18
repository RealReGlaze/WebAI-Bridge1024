#!/usr/bin/env node
/**
 * WebAI Bridge CLI —— 第二/三阶段验证版。
 *
 * 用法（Windows，npm 需用 npm.cmd）：
 *   npm.cmd start -- browser   启动专用 Edge 并附加（打开 DeepSeek，首次需手动登录）
 *   npm.cmd start -- status    显示后端连接状态与能力确认情况
 *   npm.cmd start -- probe     诊断当前页面结构与选择器命中情况（页面改版时用）
 *   npm.cmd start -- send "消息"  发送消息（等待浏览器人工发出）
 *   npm.cmd start -- reply     等待并打印最新回复
 *   npm.cmd start -- chat "消息"  send + reply 一次完成
 *   npm.cmd start -- new      新建会话
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './adapters/factory.js';
import type { BackendConfig } from './adapters/IModelAdapter.js';
import { AgentLoop } from './runtime/agent.js';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'backends.json');

interface ConfigFile {
  defaults: {
    waitForResponse: { totalTimeoutMs: number; stablePolls: number; pollIntervalMs: number };
  };
  backends: BackendConfig[];
}

function loadConfig(): ConfigFile {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ConfigFile;
}

function pickBackend(cfgFile: ConfigFile, idOption?: string): BackendConfig {
  const backends = cfgFile.backends.filter((b) => {
    const enabled = (b as BackendConfig & { enabled?: boolean }).enabled !== false;
    return enabled;
  });
  const chosen =
    backends.find((b) => b.id === idOption) ?? backends.find((b) => b.adapterType === 'deepseek-web') ?? backends[0];
  if (!chosen) throw new Error('config/backends.json 中没有可用的后端。');
  return chosen;
}

/** 绝对化 profileDir 与可执行文件路径 */
function normalize(cfgFile: ConfigFile): BackendConfig[] {
  return cfgFile.backends.map((b) => ({
    ...b,
    browser: {
      ...b.browser,
      profileDir: b.browser.profileDir
        ? path.isAbsolute(b.browser.profileDir)
          ? b.browser.profileDir
          : path.join(ROOT, b.browser.profileDir)
        : path.join(ROOT, '.runtime/edge-profile-' + b.id),
    },
  }));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const backendId = process.env['BACKEND_ID'];

  if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
    console.log(`WebAI Bridge CLI
  start -- browser              启动/复用专用 Edge 并附加 DeepSeek（首次需手动登录）
  start -- status               查看连接状态、能力确认、最近错误
  start -- probe                页面结构诊断（校准选择器）
  start -- send "..."           发送消息
  start -- reply                等待最新回复
  start -- chat "..."           发送并等待回复
  start -- state                显示网页端会话状态（URL/会话id/消息数）
  start -- new                  新建会话
  start -- agent "任务规定" [--dir 工作区] [--max 20] [--yes]
                                自动迭代闭环：网页模型提出操作，本地执行并反馈
  start -- list                 列出已完成/进行中的本地任务状态
可用 BACKEND_ID 环境变量指定后端 id。`);
    return;
  }

  const cfgFile = loadConfig();
  cfgFile.backends = normalize(cfgFile);
  const backend = pickBackend(cfgFile, backendId);
  console.log(`[cli] 后端：${backend.displayName}（${backend.id}，${backend.adapterType}）`);
  const adapter = createAdapter(backend);

  switch (cmd) {
    case 'browser': {
      const r = await adapter.connect();
      if (r.ok) {
        console.log('[cli] 已连接。若这是首次运行，请在弹出的 Edge 窗口中手动登录；登录态会保留。');
        const st = adapter.getStatus();
        console.log('[cli] 状态：', JSON.stringify(st, null, 2));
      } else {
        console.error(`[cli] 连接失败：${r.code} ${r.message}（retryable=${r.retryable}）`);
        if (r.code === 'login-required') console.log('[cli] 请在 Edge 中登录后再次运行本命令。');
        process.exitCode = 1;
      }
      return;
    }
    case 'status': {
      const r = await adapter.connect();
      const st = adapter.getStatus();
      console.log(JSON.stringify({ connected: r.ok, state: st }, null, 2));
      return;
    }
    case 'probe': {
      const b = await import('./diagnostics/probe.js');
      const diag = await b.probePage(backend);
      console.log(JSON.stringify(diag, null, 2));
      return;
    }    case 'send':
    case 'chat': {
      const text = rest.join(' ').trim();
      if (!text) {
        console.error('用法：start -- chat "消息内容"');
        process.exitCode = 1;
        return;
      }
      const conn = await adapter.connect();
      if (!conn.ok) {
        console.error(`[cli] 连接失败：${conn.code} ${conn.message}`);
        process.exitCode = 1;
        return;
      }
      const snap = (await adapter.getConversationState()).assistantMessageCount;
      const chatFp = await adapter.captureChatFingerprint();
      const netBaseline = await adapter.captureNetBaseline();
      const sent = await adapter.sendMessage(text);
      if (!sent.ok) {
        console.error(`[cli] 发送失败：${sent.code} ${sent.message}`);
        process.exitCode = 1;
        return;
      }
      console.log('[cli] 已发送，等待回复…');
      const wf = cfgFile.defaults.waitForResponse;
      const rep = await adapter.waitForResponse({
        baselineAssistantCount: snap,
        baselineChatFp: chatFp,
        netBaseline,
        sentText: text,
        totalTimeoutMs: wf.totalTimeoutMs,
        stablePolls: wf.stablePolls,
        pollIntervalMs: wf.pollIntervalMs,
      });
      if (rep.ok) {
        console.log('===== 回复开始 =====');
        console.log(rep.value.text);
        console.log('===== 回复结束 =====');
      } else {
        console.error(`[cli] 等待回复失败：${rep.code} ${rep.message}（retryable=${rep.retryable}）`);
        process.exitCode = 1;
      }
      return;
    }
    case 'reply': {
      const conn = await adapter.connect();
      if (!conn.ok) {
        console.error(`[cli] 连接失败：${conn.code} ${conn.message}`);
        process.exitCode = 1;
        return;
      }
      const snap = (await adapter.getConversationState()).assistantMessageCount;
      const wf = cfgFile.defaults.waitForResponse;
      const rep = await adapter.waitForResponse({
        baselineAssistantCount: snap - 1,
        totalTimeoutMs: wf.totalTimeoutMs,
        stablePolls: wf.stablePolls,
        pollIntervalMs: wf.pollIntervalMs,
      });
      if (rep.ok) {
        console.log(rep.value.text);
      } else {
        console.error(`[cli] 失败：${rep.code} ${rep.message}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'new':
    case 'state': {
      const conn = await adapter.connect();
      if (!conn.ok) {
        console.error(`[cli] 连接失败：${conn.code} ${conn.message}`);
        process.exitCode = 1;
        return;
      }
      const st = await adapter.getConversationState();
      if (cmd === 'state') {
        console.log(JSON.stringify(st, null, 2));
        return;
      }
      const r = await adapter.startNewConversation();
      console.log(r.ok ? '[cli] 已新建会话。' : `[cli] 新建会话：${r.code} ${r.message}`);
      return;
    }
    case 'list': {
      const dir = path.join(ROOT, '.runtime', 'tasks');
      if (!existsSync(dir)) {
        console.log('（暂无任务）');
        return;
      }
      const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      if (files.length === 0) {
        console.log('（暂无任务）');
        return;
      }
      for (const f of files) {
        try {
          const s = JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as {
            sessionId: string; status: string; goal: string; adapterId: string; summary?: string; rounds: unknown[];
          };
          console.log(`${s.sessionId} [${s.status}] ${s.adapterId} | 轮数=${s.rounds.length} | ${s.goal.slice(0, 50)}${s.summary ? ` | ${s.summary.slice(0, 60)}` : ''}`);
        } catch {
          /* 忽略损坏文件 */
        }
      }
      return;
    }
    case 'agent': {
      const flagIndex = rest.findIndex((r) => r.startsWith('--'));
      const goalWords = flagIndex === -1 ? rest : rest.slice(0, flagIndex);
      const flags = flagIndex === -1 ? [] : rest.slice(flagIndex);
      const goal = goalWords.join(' ').trim();
      if (!goal) {
        console.error('用法：start -- agent "任务目标" [--dir 相对目录] [--max 20] [--yes]');
        process.exitCode = 1;
        return;
      }
      if (flags.includes('--yes')) {
        console.log('[agent] 已启用 --yes：高风险操作自动放行（不再逐项人工确认）。');
      }
      const dirFlag = flags.find((f) => f.startsWith('--dir'));
      const dirIdx = dirFlag ? flags.indexOf(dirFlag) : -1;
      const workspaceRoot = dirFlag && dirIdx >= 0 ? path.resolve(ROOT, flags[dirIdx + 1] ?? '.') : path.resolve(ROOT, 'sandbox-tasks', 'current');
      if (!existsSync(workspaceRoot)) {
        mkdirSync(workspaceRoot, { recursive: true });
        console.log(`[agent] 工作区不存在，已创建：${workspaceRoot}`);
      }
      const maxFlag = flags.find((f) => f.startsWith('--max'));
      const maxIdx = maxFlag ? flags.indexOf(maxFlag) : -1;
      const maxRounds = maxFlag && maxIdx >= 0 ? Number(flags[maxIdx + 1] ?? 15) : 15;
      const conn = await adapter.connect();
      if (!conn.ok) {
        console.error(`[cli] 连接失败：${conn.code} ${conn.message}`);
        process.exitCode = 1;
        return;
      }
      const wf = cfgFile.defaults.waitForResponse;
      const loop = new AgentLoop(adapter, {
        goal,
        workspaceRoot,
        maxRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? maxRounds : 15,
        autoApprove: flags.includes('--yes'),
        waitFor: {
          baselineAssistantCount: 0,
          totalTimeoutMs: wf.totalTimeoutMs,
          stablePolls: wf.stablePolls,
          pollIntervalMs: wf.pollIntervalMs,
          rejectPatterns: ['服务繁忙', '请稍后再试', '访问被拒绝'],
        },
      });
      console.log(`[agent] 会话=${loop.sessionId || '（运行中生成）'} 工作区=${workspaceRoot} 最大轮数=${maxRounds}`);
      const done = await loop.run();
      console.log(`[agent] 结束：${done.status}`);
      if (done.summary) console.log(`[agent] 总结：${done.summary}`);
      return;
    }
    default:
      console.error(`未知命令：${cmd}`);
      process.exitCode = 1;
  }
}

main()
  .catch((e: unknown) => {
    console.error('[cli] 发生未处理错误：', e);
    process.exit(1);
  })
  .finally(() => {
    // CDP 连接会保持事件循环，任何子命令完成后都显式退出（不关闭 Edge 实例本身）
    process.exit(process.exitCode ?? 0);
  });
