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
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './adapters/factory.js';
import type { BackendConfig, IModelAdapter } from './adapters/IModelAdapter.js';
import { AgentLoop, clearQueuedLines, readLineOnce, summarizeSessionDigest, type AgentSessionState } from './runtime/agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'backends.json');

/** 用户打开命令行时的目录（webai.cmd 在 pushd 项目根前捕获并传入）。默认工作区以此为准。 */
const INVOKED_CWD =
  process.env['WEBAI_INVOKED_CWD'] && path.isAbsolute(process.env['WEBAI_INVOKED_CWD'])
    ? process.env['WEBAI_INVOKED_CWD']
    : process.cwd();

interface ConfigFile {
  defaults: {
    waitForResponse: { totalTimeoutMs: number; stablePolls: number; pollIntervalMs: number };
  };
  backends: BackendConfig[];
}

/** 版本号取自 package.json（--version 与交互横幅显示） */
const VERSION: string =
  (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { version?: string }).version ?? '0.0.0';

/* ---------------- 跨对话/跨模型前情摘要（滚动记忆库） ---------------- */
interface ContextEntry {
  at: number;
  model: string;
  goal: string;
  digest: string;
}
interface ContextStore {
  workspaces: Record<string, ContextEntry[]>;
}
const CONTEXT_FILE = path.join(ROOT, '.runtime', 'context.json');

function loadContextStore(): ContextStore {
  try {
    const raw = JSON.parse(readFileSync(CONTEXT_FILE, 'utf-8')) as ContextStore;
    return raw && raw.workspaces ? raw : { workspaces: {} };
  } catch {
    return { workspaces: {} };
  }
}

function saveContextStore(store: ContextStore): void {
  mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  writeFileSync(CONTEXT_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

/** 取某工作区的前情摘要（拼接最近 3 条任务，总量截到 ~4000 字符） */
function digestForWorkspace(store: ContextStore, workspaceRoot: string): string {
  const list = store.workspaces[workspaceRoot] ?? [];
  const text = list
    .map((e) => `- ${new Date(e.at).toLocaleString()}（${e.model}）` + '\n' + e.digest)
    .join('\n');
  return text.length > 4000 ? text.slice(text.length - 4000) : text;
}

function appendDigest(store: ContextStore, workspaceRoot: string, entry: ContextEntry): void {
  const list = store.workspaces[workspaceRoot] ?? (store.workspaces[workspaceRoot] = []);
  list.push(entry);
  store.workspaces[workspaceRoot] = list.slice(-3);
  saveContextStore(store);
}

/** 审批模型 = 第一个「非当前执行方」的已启用后端（auto/accept-all 放行时由它 Allow/Refuse，遵守 /wait 节流） */
function buildApprover(currentId: string, cfgFile: { backends: BackendConfig[] }): { adapter: IModelAdapter; label: string } | undefined {
  const other = cfgFile.backends.find(
    (b) => (b as BackendConfig & { enabled?: boolean }).enabled !== false && b.id !== currentId,
  );
  return other ? { adapter: createAdapter(other), label: other.displayName } : undefined;
}

function loadConfig(): ConfigFile {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ConfigFile;
}

function pickBackend(cfgFile: ConfigFile, idOption?: string): BackendConfig {
  const backends = cfgFile.backends.filter((b) => {
    const enabled = (b as BackendConfig & { enabled?: boolean }).enabled !== false;
    return enabled;
  });
  let chosen: BackendConfig | undefined;
  if (idOption) {
    const key = idOption.toLowerCase();
    chosen =
      backends.find((b) => b.id === idOption) ??
      backends.find((b) => b.id.toLowerCase().includes(key) || b.displayName.toLowerCase().includes(key));
  }
  chosen = chosen ?? backends.find((b) => b.adapterType === 'deepseek-web') ?? backends[0];
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

/** 任务执行核心：连接 → 新会话 → 循环 → 汇报。供 ci 命令与交互模式复用。 */
async function executeTask(
  adapter: IModelAdapter,
  wf: { totalTimeoutMs: number; stablePolls: number; pollIntervalMs: number },
  params: {
    goal: string;
    workspaceRoot: string;
    maxRounds: number;
    autoApprove: boolean;
    backendName?: string;
    resumeSession?: AgentSessionState;
    contextDigest?: string;
    pacingMs?: number;
    deepThink?: boolean;
    approver?: { adapter: IModelAdapter; label: string };
  },
): Promise<{ ok: boolean; session: AgentSessionState | null }> {
  const conn = await adapter.connect();
  if (!conn.ok) {
    console.error(`[ci] 连接失败：${conn.code} ${conn.message}`);
    return { ok: false, session: null };
  }
  if (params.autoApprove) {
    if (params.approver) console.log(`[审批] 执行方 ${params.backendName ?? adapter.backendId}；审批模型：${params.approver.label}（自动放行时逐次请求其 Allow/Refuse，遵守 /wait 节流）`);
    else console.log('[审批] 无第二个可用后端作为审批模型：自动放行将直接生效。');
  }
  const loop = new AgentLoop(adapter, {
    goal: params.resumeSession ? params.resumeSession.goal : params.goal,
    workspaceRoot: params.workspaceRoot,
    maxRounds: params.maxRounds,
    autoApprove: params.autoApprove,
    resumeSession: params.resumeSession,
    contextDigest: params.contextDigest,
    pacingMs: params.pacingMs,
    deepThink: params.deepThink,
    approver: params.approver,
    waitFor: {
      baselineAssistantCount: 0,
      totalTimeoutMs: wf.totalTimeoutMs,
      stablePolls: wf.stablePolls,
      pollIntervalMs: wf.pollIntervalMs,
      rejectPatterns: ['服务繁忙', '请稍后再试', '访问被拒绝'],
    },
  });
  console.log(
    `[ci] 任务=${loop.sessionId} 工作区=${params.workspaceRoot} 后端=${params.backendName ?? '网页模型'} 本轮上限=${params.maxRounds}轮${params.autoApprove ? ' 自动放行' : ''}`,
  );
  // 注入会话标识环境变量：run_command 派生的孙进程（含 webai 自身）将因 WEBAI_AGENT_SESSION 被拒
  process.env['WEBAI_AGENT_SESSION'] = loop.sessionId;
  const done = await loop.run();
  delete process.env['WEBAI_AGENT_SESSION'];
  console.log(`[ci] 结束：${done.status}（${done.rounds.length} 轮）`);
  if (done.summary) console.log(`[ci] 总结：${done.summary}`);
  return { ok: done.status === 'finished', session: done };
}

/** 无参交互模式：版本横幅 + >> 引导输入。工作目录 = 启动时的当前目录；ask/work 模式由模型自声明、轮数预算自动切换。 */
async function runInteractive(restArgs: string[]): Promise<void> {
  // 启动旗标：[-t 轮数] [--yes] [--debug] [-C 目录] [--backend 后端]（-C 相对路径基于用户命令行目录）
  let turns = 20;
  let auto = false;
  let workspaceRoot = INVOKED_CWD;
  let backendChoice = process.env['BACKEND_ID'];
  for (let i = 0; i < restArgs.length; i++) {
    const a = restArgs[i]!;
    if (a === '--yes') auto = true;
    else if (a === '--debug') process.env['WEBAI_DEBUG'] = '1';
    else if (a === '-t' || a === '--turns' || a === '--max') turns = Math.min(Math.max(Number(restArgs[++i] ?? 20) || 20, 1), 50);
    else if (a === '-C' || a === '--dir') workspaceRoot = path.resolve(INVOKED_CWD, restArgs[++i] ?? '.');
    else if (a === '--backend') backendChoice = restArgs[++i];
    else if (a) {
      console.error(`[interactive] 无法识别的参数：${a}（交互模式不带任务目标文本，goals 请用 ci 命令）`);
      process.exitCode = 1;
      return;
    }
  }
  const cfgFile = loadConfig();
  cfgFile.backends = normalize(cfgFile);
  const wf = cfgFile.defaults.waitForResponse;
  const currentBackend = () => pickBackend(cfgFile, backendChoice);
  const backend = currentBackend();

  // 会话级状态：每模型深度思考开关、轮间节流秒数、前情摘要库
  const deepMap: Record<string, boolean> = {};
  let waitSec = 0;
  let contextStore = loadContextStore();

  console.log();
  console.log(`=========================================================================`);
  console.log(`                     Welcome to WebAI Bridge CLI!`);
  console.log(`  WebAI Bridge v${VERSION}   后端：${backend.displayName}（${backend.id}）`);
  console.log(`  工作目录：${workspaceRoot}`);
  console.log(`  模式自动切换：模型首轮声明 <mode>ask</mode>（快问快答/3 轮）或 <mode>work</mode>（正式任务/${turns} 轮）`);
  console.log('  输入任务目标后回车即执行；/model <name> · /deep-on|off · /wait <s> · /ctx · /tasks · /auto · /accept-all · /continue · /exit');
  console.log(`=========================================================================`);
  if (auto) console.log('  [--yes] 高风险操作自动放行。');
  console.log();

  // 行输入全部走一次性 readline（与工具 y/N 确认互不抢占 stdin）
  const askLine = (): Promise<string | null> => readLineOnce('>> ');
  for (;;) {
    console.log();
    const line = await askLine();
    if (line === null) break; // EOF / Ctrl+C
    if (!line) continue;
    if (/^(\/exit|\/quit|exit|quit)$/i.test(line)) break;
    if (/^\/auto\b/i.test(line)) {
      const m = /^\/auto\s+(on|off)\s*$/i.exec(line);
      if (!m) {
        console.log('用法：/auto on 或 /auto off（自动审批自下一个任务→新开启的对话起生效）');
        continue;
      }
      auto = m[1]!.toLowerCase() === 'on';
      console.log(`[审批] 自动审批已${auto ? '开启' : '关闭'}（自下一个任务的新对话生效）。`);
      continue;
    }
    if (/^\/accept-all\s*$/i.test(line)) {
      if (auto) {
        console.log('[审批] 自动审批已是开启状态（/auto off 可关闭）。');
        continue;
      }
      console.log('[审批] /accept-all 将对本会话所有后续任务自动放行高风险操作（含写文件/执行命令）。');
      const yn = await readLineOnce('二次确认：真的要全部允许吗？(y/N) ');
      if (yn && /^\s*y(es)?\s*$/i.test(yn)) {
        auto = true;
        console.log('[审批] 已全部允许（仅本次会话；恢复人工确认请输入 /auto off）。');
      } else {
        console.log('[审批] 已取消，维持逐项人工确认。');
      }
      continue;
    }
    if (/^\/help\b/i.test(line)) {
      console.log('命令：/model <name|list>（/switch 同义）· /deep-on|off 深度思考 · /wait <秒> 节流防风控 · /ctx [clear] 前情摘要 · /tasks · /show <ID> [--transcript] · /auto on|off · /accept-all · /continue [ID] · /exit 退出');
      continue;
    }
    if (/^\/model\b/i.test(line) || /^\/switch\b/i.test(line)) {
      const m = /^(?:\/model|\/switch)(?:\s+(\S+))?\s*$/i.exec(line);
      if (!m || !m[1]) {
        console.log('可用后端：' + cfgFile.backends.filter((b) => (b as BackendConfig & { enabled?: boolean }).enabled !== false).map((b) => `${b.displayName}（${b.id}）`).join('，'));
        console.log('用法：/model <后端名>（或 /switch <后端名>；对下一个任务的新对话生效）');
        continue;
      }
      const key = m[1]!.toLowerCase();
      if (key === 'list') {
        console.log('可用后端：' + cfgFile.backends.filter((b) => (b as BackendConfig & { enabled?: boolean }).enabled !== false).map((b) => `${b.displayName}（${b.id}）`).join('，'));
        continue;
      }
      const hit = cfgFile.backends.find(
        (b) =>
          (b as BackendConfig & { enabled?: boolean }).enabled !== false &&
          (b.id === m[1] || b.id.toLowerCase().includes(key) || b.displayName.toLowerCase().includes(key)),
      );
      if (!hit) {
        console.log(`[后端] 没有匹配「${m[1]}」的已启用后端。可用：${cfgFile.backends.filter((b) => (b as BackendConfig & { enabled?: boolean }).enabled !== false).map((b) => b.id).join('，')}`);
        continue;
      }
      backendChoice = hit.id;
      console.log(`[后端] 已切换：${hit.displayName}（${hit.id}）——对下一个任务的新对话生效。深度思考=${deepMap[hit.id] === undefined ? '不动页面开关' : deepMap[hit.id] ? '开' : '关'}（/deep-on · /deep-off）`);
      continue;
    }
    if (/^\/deep-on\s*$/i.test(line) || /^\/deep-off\s*$/i.test(line)) {
      const on = /^\/deep-on/i.test(line);
      deepMap[currentBackend().id] = on;
      console.log(`[深度思考] ${currentBackend().displayName}（${currentBackend().id}）→ ${on ? '开' : '关'}；自下一个任务的新对话生效（新对话打开后由 Harness 点击页面开关）。`);
      continue;
    }
    if (/^\/wait\b/i.test(line)) {
      const m = /^\/wait\s*(\d+)?\s*$/i.exec(line);
      if (!m) {
        console.log('用法：/wait <秒数>（0 = 关闭节流；每轮发送前等待，防风控）');
        continue;
      }
      waitSec = Math.min(Number(m[1] ?? 0) || 0, 600);
      console.log(waitSec ? `[节流] 已设置：每轮发送前等待 ${waitSec}s。` : '[节流] 已关闭（0s）。');
      continue;
    }
    if (/^\/ctx\b/i.test(line)) {
      const m = /^\/ctx(?:\s+(clear))?\s*$/i.exec(line);
      if (m && m[1] === 'clear') {
        contextStore = loadContextStore();
        delete contextStore.workspaces[workspaceRoot];
        saveContextStore(contextStore);
        console.log('[前情] 已清空当前工作区的摘要库。');
        continue;
      }
      const d = digestForWorkspace(contextStore, workspaceRoot);
      console.log(d ? `[前情] 当前工作区摘要（自动注入新对话）：\n${d}` : '[前情] 当前工作区暂无摘要（任务完成后自动累积；/ctx clear 清空）。');
      continue;
    }
    if (/^\/continue\b/i.test(line)) {
      const m = /^\/continue(?:\s+(\S+))?\s*$/i.exec(line);
      if (!m) continue;
      const tasksDir = path.join(ROOT, '.runtime', 'tasks');
      if (!existsSync(tasksDir)) {
        console.log('（暂无任务会话，无可续跑）');
        continue;
      }
      const all = readdirSync(tasksDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            return JSON.parse(readFileSync(path.join(tasksDir, f), 'utf-8')) as AgentSessionState;
          } catch {
            return null;
          }
        })
        .filter((s): s is AgentSessionState => !!s && path.resolve(s.workspaceRoot) === path.resolve(workspaceRoot));
      const target = m[1]
        ? all.find((s) => s.sessionId === m[1])
        : all.filter((s) => s.status !== 'finished').sort((x, y) => y.updatedAt - x.updatedAt)[0];
      if (!target) {
        console.log(m[1] ? `未找到任务 ${m[1]}` : '当前工作区没有未完成的任务（全部已完成）。');
        continue;
      }
      if (target.status === 'finished') {
        console.log(`任务 ${target.sessionId} 已完成，无需续跑（重做请直接发新任务）。`);
        continue;
      }
      const backend2 = currentBackend();
      console.log(`[continue] 续跑 ${target.sessionId}（${target.status}，${target.rounds.length} 轮）→ 后端 ${backend2.displayName}${target.adapterId !== backend2.id ? '（跨模型交接：原后端 ' + target.adapterId + '）' : ''}`);
      try {
        await executeTask(createAdapter(backend2), wf, {
          goal: target.goal,
          workspaceRoot,
          maxRounds: turns,
          autoApprove: auto,
          backendName: backend2.displayName,
          resumeSession: target,
          pacingMs: waitSec * 1000,
          deepThink: deepMap[backend2.id],
          approver: buildApprover(backend2.id, cfgFile),
        });
      } catch (e) {
        console.error('[continue] 任务执行异常：', e);
      } finally {
        clearQueuedLines();
      }
      continue;
    }
    if (/^\/tasks$/i.test(line)) {
      const dir = path.join(ROOT, '.runtime', 'tasks');
      if (!existsSync(dir)) {
        console.log('（暂无任务）');
        continue;
      }
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          const s = JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as AgentSessionState;
          console.log(`${s.sessionId} [${s.status}] ${s.goal.slice(0, 40)}${s.summary ? ` | ${s.summary.slice(0, 40)}` : ''}`);
        } catch {
          /* 忽略损坏文件 */
        }
      }
      continue;
    }
    const m = /^\/show\s+(\S+)\s*(--transcript)?/i.exec(line);
    if (m) {
      const f = path.join(ROOT, '.runtime', 'tasks', `${m[1]}.json`);
      if (!existsSync(f)) {
        console.error(`[show] 未找到任务会话：${m[1]}`);
        continue;
      }
      const s = JSON.parse(readFileSync(f, 'utf-8')) as AgentSessionState;
      console.log(`任务 ${s.sessionId} [${s.status}] 目标：${s.goal}`);
      if (s.summary) console.log(`总结 ${s.summary}`);
      console.log(`（轮次详情与 /transcript 见 start -- show ${s.sessionId} --transcript）`);
      continue;
    }
    if (line.startsWith('/')) {
      console.log('未知命令（/model /deep-on|off /wait /ctx /tasks /show /auto /accept-all /continue /help /exit）');
      continue;
    }
    // 任务执行：行读取已在工具确认间放开（一次性接口），无需 pause/resume
    try {
      const backendForTask = currentBackend();
      const adapterForTask = createAdapter(backendForTask);
      const result = await executeTask(adapterForTask, wf, {
        goal: line,
        workspaceRoot,
        maxRounds: turns,
        autoApprove: auto,
        backendName: backendForTask.displayName,
        contextDigest: digestForWorkspace(contextStore, workspaceRoot),
        pacingMs: waitSec * 1000,
        deepThink: deepMap[backendForTask.id],
        approver: buildApprover(backendForTask.id, cfgFile),
      });
      // 任务结束后滚动累积前情摘要（跨对话/跨模型接力；最多保留最近 3 条）
      if (result.session) {
        appendDigest(contextStore, workspaceRoot, {
          at: Date.now(),
          model: backendForTask.id,
          goal: result.session.goal.slice(0, 120),
          digest: summarizeSessionDigest(result.session),
        });
      }
    } catch (e) {
      console.error('[interactive] 任务执行异常：', e);
    } finally {
      // 该任务的预喂行已用尽：清掉缓冲中残留的（如多余的 y/确认行），避免被误当下一个目标
      clearQueuedLines();
    }
    console.log();
  }
  console.log('[interactive] 已退出。');
}

async function main() {
  const [, , cmd0, ...rest] = process.argv;

  if (cmd0 === '--version' || cmd0 === '-v') {
    console.log(`WebAI Bridge v${VERSION}`);
    return;
  }
  // 无参（或只带 -t/--yes 等旗标）启动 → 交互模式（Claude 式：版本横幅 + >> 引导输入；工作目录=当前目录）
  if (!cmd0 || cmd0.startsWith('-')) {
    await runInteractive(cmd0 ? [cmd0, ...rest] : rest);
    return;
  }
  if (['help', '--help', '-h'].includes(cmd0)) {
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
  交互模式命令：/model <name|list> · /deep-on|off（深度思考）· /wait <秒>（节流）· /ctx [clear]（前情摘要）· /tasks · /show · /auto on|off · /accept-all · /continue [ID] · /help · /exit
启动器：项目 bin/webai.cmd（任意目录调用，如 webai.cmd ci "修复所有测试" -C E:\\proj）
可用 BACKEND_ID 环境变量或 --backend <后端> 指定后端 id；WEBAI_DEBUG=1 输出回复等待诊断。`);
    return;
  }

  const cfgFile = loadConfig();
  cfgFile.backends = normalize(cfgFile);
  // 全局旗标 --backend <后端id|名称>（优先于 BACKEND_ID 环境变量；对所有子命令生效）
  let backendChoice = process.env['BACKEND_ID'];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--backend') {
      backendChoice = rest[i + 1] ?? '';
      rest.splice(i, 2);
      i--;
    }
  }
  const backend = pickBackend(cfgFile, backendChoice);
  console.log(`[cli] 后端：${backend.displayName}（${backend.id}，${backend.adapterType}）`);
  const adapter = createAdapter(backend);

  switch (cmd0) {
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
      if (cmd0 === 'state') {
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
      const ci = cmd0 === 'ci';
      // 解析参数：非旗标 token 视作目标语句（Claude Code 风格）；-C/--dir 指定工作区
      const goalWords: string[] = [];
      const flags: Record<string, string | boolean> = {};
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--yes') flags['yes'] = true;
        else if (a === '--continue') flags['continue'] = true;
        else if (a === '--debug') flags['debug'] = true;
        else if (a === '--backend') { flags['backend'] = rest[++i] ?? ''; }
        else if (a === '--wait') { flags['wait'] = rest[++i] ?? '0'; }
        else if (a === '--deep') flags['deep'] = true;
        else if (a === '--deep-off') flags['deepOff'] = true;
        else if (a === '--no-ctx') flags['noCtx'] = true;
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
      // 工作区：默认用户命令行所在目录（同 Claude Code 在目标目录里运行）；agent 保持旧默认
      const dirValue = typeof flags['dir'] === 'string' ? flags['dir'] : '';
      const workspaceRoot = dirValue
        ? path.resolve(INVOKED_CWD, dirValue)
        : ci
          ? INVOKED_CWD
          : path.resolve(ROOT, 'sandbox-tasks', 'current');
      if (!existsSync(workspaceRoot)) {
        mkdirSync(workspaceRoot, { recursive: true });
        console.log(`[ci] 工作区不存在，已创建：${workspaceRoot}`);
      }
      const maxRounds = Math.min(Math.max(Number(flags['turns'] ?? 15) || 15, 1), 50); // 钳制防模型任意传大值
      const turns = maxRounds;
      const autoApprove = flags['yes'] === true;
      if (autoApprove) console.log('[ci] 已启用 --yes：高风险操作自动放行（不再逐项人工确认）。');
      const waitFlag = Math.min(Math.max(Number(flags['wait'] ?? 0) || 0, 0), 600);
      if (waitFlag > 0) console.log(`[ci] 已启用 --wait ${waitFlag}s：每轮发送前节流等待。`);
      const deepFlag = flags['deep'] === true ? true : flags['deepOff'] === true ? false : undefined;
      if (deepFlag !== undefined) console.log(`[ci] 深度思考开关：${deepFlag ? '开' : '关'}（连接后点击页面开关）。`);
      const noCtx = flags['noCtx'] === true;
      if (noCtx) console.log('[ci] 已禁用前情摘要注入（--no-ctx）。');

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

      const result = await executeTask(adapter, cfgFile.defaults.waitForResponse, {
        goal,
        workspaceRoot,
        maxRounds: turns,
        autoApprove,
        backendName: backend.displayName,
        resumeSession,
        contextDigest: noCtx ? undefined : digestForWorkspace(loadContextStore(), workspaceRoot),
        pacingMs: waitFlag * 1000,
        deepThink: deepFlag,
        approver: buildApprover(backend.id, cfgFile),
      });
      // ci 也滚动累积前情摘要（除非 --no-ctx）
      if (!noCtx && result.session) {
        appendDigest(loadContextStore(), workspaceRoot, {
          at: Date.now(),
          model: backend.id,
          goal: result.session.goal.slice(0, 120),
          digest: summarizeSessionDigest(result.session),
        });
      }
      // CI 语义：完成=0，失败/停止=1（方便流水线判断）
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    default:
      console.error(`未知命令：${cmd0}`);
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
