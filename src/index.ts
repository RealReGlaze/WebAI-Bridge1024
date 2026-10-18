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
import { AgentLoop, type AgentSessionState } from './runtime/agent.js';
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
    console.log(`WebAI Bridge CLI —— 类 Claude Code 的本地 AI Agent 命令行
  webai ci "任务目标" [-C 目录] [-t 轮数] [--yes] [--resume ID | --continue]
                                     一键任务闭环（默认在当前目录工作，完成=退出码0）
                                     -C 指定工作区；-t 本轮最大轮数；--yes 自动放行高风险操作
                                     --resume 恢复指定任务；--continue 恢复同工作区最近未完成任务
  start -- agent "任务" [--dir dir] [--max N] [--yes]   旧版入口（默认工作区 sandbox-tasks/current）
  start -- chat "..."           单轮对话：发送并等待回复
  start -- send/reply/new/state 浏览器会话基础操作
  start -- browser/status/probe 连接、状态、页面结构诊断
  start -- list                 列出本地任务会话（.runtime/tasks）
  start -- show <ID> [--transcript]  查看某任务的轮次/总结/完整成果（嵌套被拦后成果不会失踪）
启动器：项目 bin/webai.cmd（任意目录调用，如 webai.cmd ci "修复所有测试" -C E:\\proj）
可用 BACKEND_ID 环境变量指定后端 id；WEBAI_DEBUG=1 输出回复等待诊断。`);
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
    case 'show': {
      const id = rest[0] ?? '';
      const full = rest.includes('--transcript');
      if (!id) {
        console.error('用法：start -- show <任务ID> [--transcript]（ID 来自 start -- list）');
        process.exitCode = 1;
        return;
      }
      const f = path.join(ROOT, '.runtime', 'tasks', `${id}.json`);
      if (!existsSync(f)) {
        console.error(`[show] 未找到任务会话：${id}`);
        process.exitCode = 1;
        return;
      }
      const s = JSON.parse(readFileSync(f, 'utf-8')) as AgentSessionState;
      console.log(`任务     ${s.sessionId}`);
      console.log(`状态     ${s.status}   后端 ${s.adapterId}`);
      console.log(`时间     开始 ${new Date(s.startedAt).toLocaleString()}  更新 ${new Date(s.updatedAt).toLocaleString()}`);
      console.log(`工作区   ${s.workspaceRoot}`);
      console.log(`目标     ${s.goal}`);
      if (s.summary) console.log(`总结     ${s.summary}`);
      console.log('轮次     ');
      for (const r of s.rounds) {
        const calls = r.calls.length
          ? r.calls.map((c) => `${c.name}(${c.digest ?? ''})→${c.ok ? 'ok' : 'fail'}`).join('；')
          : r.error ?? '-';
        console.log(`  第${r.round}轮 ${calls}`);
      }
      if (full) {
        console.log('==== 完整转录 ====');
        for (const t of s.transcript) {
          const head = t.role === 'user' ? '【用户】' : '【助手】';
          const body = t.text.length > 2500 ? `${t.text.slice(0, 2500)}\n…[截断，共 ${t.text.length} 字符]` : t.text;
          console.log(`${head}（${new Date(t.timestamp).toLocaleTimeString()}）\n${body}\n`);
        }
      }
      return;
    }
    case 'ci':
    case 'agent': {
      const ci = cmd === 'ci';
      // 解析参数：非旗标 token 视作目标语句（Claude Code 风格）；-C/--dir 指定工作区
      const goalWords: string[] = [];
      const flags: Record<string, string | boolean> = {};
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--yes') flags['yes'] = true;
        else if (a === '--continue') flags['continue'] = true;
        else if (a === '--debug') flags['debug'] = true;
        else if (a === '--resume') { flags['resume'] = rest[++i] ?? ''; }
        else if (a === '-C' || a === '--dir') { flags['dir'] = rest[++i] ?? '.'; }
        else if (a === '--max-turns' || a === '-t' || a === '--max') { flags['turns'] = rest[++i] ?? ''; }
        else goalWords.push(a);
      }
      // 嵌套守卫：任务内不允许递归调用 webai 自身（防无限递归与网页配额透支）。
      // run_command 继承本进程环境变量，其孙进程同样被拦截。
      const parentId = process.env['WEBAI_AGENT_SESSION'];
      if (parentId) {
        console.error(
          `[ci] 检测到嵌套调用（父任务 ${parentId}）：webai 禁止在任务内递归调用自身。` +
            '请直接用 list_files / read_file 等工具完成检查，不要通过 run_command 启动新 Agent。',
        );
        process.exitCode = 1;
        return;
      }
      const goal = goalWords.join(' ').trim();
      if (flags['debug']) process.env['WEBAI_DEBUG'] = '1';
      const resumeId = typeof flags['resume'] === 'string' ? (flags['resume'] as string).trim() : '';
      if (!goal && !resumeId && !flags['continue']) {
        console.error(
          ci
            ? '用法：webai ci "任务目标" [-C 工作区目录] [-t 轮数] [--yes] [--resume 任务ID | --continue]'
            : '用法：start -- agent "任务目标" [--dir 相对目录] [--max 20] [--yes]',
        );
        process.exitCode = 1;
        return;
      }
      // 工作区：ci 默认当前进程目录（同 Claude Code 在目标目录里运行）；agent 保持旧默认
      const dirValue = typeof flags['dir'] === 'string' ? flags['dir'] : '';
      const workspaceRoot = dirValue
        ? path.resolve(process.cwd(), dirValue)
        : ci
          ? process.cwd()
          : path.resolve(ROOT, 'sandbox-tasks', 'current');
      if (!existsSync(workspaceRoot)) {
        mkdirSync(workspaceRoot, { recursive: true });
        console.log(`[ci] 工作区不存在，已创建：${workspaceRoot}`);
      }
      const maxRounds = Math.min(Math.max(Number(flags['turns'] ?? 15) || 15, 1), 50); // 钳制防模型任意传大值
      const turns = maxRounds;
      const autoApprove = flags['yes'] === true;
      if (autoApprove) console.log('[ci] 已启用 --yes：高风险操作自动放行（不再逐项人工确认）。');

      // 续跑：--resume <id> 精确恢复；--continue 恢复同工作区最近的未完成任务
      let resumeSession: AgentSessionState | undefined;
      const tasksDir = path.join(ROOT, '.runtime', 'tasks');
      const mine = (s: AgentSessionState) =>
        path.resolve(s?.workspaceRoot ?? '') === path.resolve(workspaceRoot);
      if (resumeId) {
        const f = path.join(tasksDir, `${resumeId}.json`);
        if (!existsSync(f)) {
          console.error(`[ci] 未找到任务会话：${resumeId}（用 start -- list 查看全部任务）`);
          process.exitCode = 1;
          return;
        }
        resumeSession = JSON.parse(readFileSync(f, 'utf-8')) as AgentSessionState;
      } else if (flags['continue'] === true) {
        if (!existsSync(tasksDir)) {
          console.error('[ci] 尚无任何任务会话，无可续跑。');
          process.exitCode = 1;
          return;
        }
        const candidates = readdirSync(tasksDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => {
            try {
              return JSON.parse(readFileSync(path.join(tasksDir, f), 'utf-8')) as AgentSessionState;
            } catch {
              return null;
            }
          })
          .filter((s): s is AgentSessionState => !!s && mine(s) && s.status !== 'finished')
          .sort((x, y) => y.updatedAt - x.updatedAt);
        if (candidates.length === 0) {
          console.error(`[ci] 工作区 ${workspaceRoot} 没有可续跑的未完成任务。`);
          process.exitCode = 1;
          return;
        }
        resumeSession = candidates[0];
      }
      if (resumeSession) {
        console.log(
          `[ci] 续跑会话=${resumeSession.sessionId}（状态 ${resumeSession.status}，已完成 ${resumeSession.rounds.length} 轮）`,
        );
      }

      const conn = await adapter.connect();
      if (!conn.ok) {
        console.error(`[ci] 连接失败：${conn.code} ${conn.message}`);
        process.exitCode = 1;
        return;
      }
      const wf = cfgFile.defaults.waitForResponse;
      const loop = new AgentLoop(adapter, {
        goal: resumeSession ? resumeSession.goal : goal,
        workspaceRoot,
        maxRounds: turns,
        autoApprove,
        resumeSession,
        waitFor: {
          baselineAssistantCount: 0,
          totalTimeoutMs: wf.totalTimeoutMs,
          stablePolls: wf.stablePolls,
          pollIntervalMs: wf.pollIntervalMs,
          rejectPatterns: ['服务繁忙', '请稍后再试', '访问被拒绝'],
        },
      });
      console.log(
        `[ci] 任务=${loop.sessionId} 工作区=${workspaceRoot} 后端=${backend.displayName} 本轮上限=${turns}轮${autoApprove ? ' 自动放行' : ''}`,
      );
      // 注入会话标识环境变量：run_command 派生的孙进程（含 webai 自身）将因 WEBAI_AGENT_SESSION 被拒
      process.env['WEBAI_AGENT_SESSION'] = loop.sessionId;
      const done = await loop.run();
      console.log(`[ci] 结束：${done.status}（${done.rounds.length} 轮）`);
      if (done.summary) console.log(`[ci] 总结：${done.summary}`);
      // CI 语义：完成=0，失败/停止=1（方便流水线判断）
      process.exitCode = done.status === 'finished' ? 0 : 1;
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
