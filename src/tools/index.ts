/**
 * 统一工具层：模型只能"提出"操作请求，实际执行全部在本地完成。
 * 执行前经过：路径沙箱校验、deny 名单、命令白名单、可选人工确认。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { matchDenyPrefix, resolveSandboxPath, type AgentPolicy } from './policy.js';

export interface ToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description: string;
}

export interface ToolContext {
  workspaceRoot: string;
  policy: AgentPolicy;
  /** 高风险操作确认钩子（CLI 会转成人工 y/n 或审批模型 Allow/Refuse；detail=操作的原始内容，供审批模型判断） */
  confirm: (title: string, detail?: string) => Promise<boolean>;
  /** AgentLoop 已完成统一确认时使用，避免同一操作重复询问。 */
  skipConfirm?: boolean;
}

export interface ToolOutput {
  ok: boolean;
  output: string;
  /** 是否已经向模型反馈过"需要人工确认被拒绝"等特殊语义 */
  rejected?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  params: ToolParam[];
  /** 返回 null 表示无需确认；返回 string 则作为确认提示（ctx 供命令白名单判断用） */
  confirmHint?: (args: Record<string, unknown>, ctx: ToolContext) => string | null;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

/* ---------------- 参数辅助 ---------------- */

function str(args: Record<string, unknown>, name: string, fallback?: string): string {
  const v = args[name];
  if (typeof v === 'string') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少必需参数 ${name}`);
}

function num(args: Record<string, unknown>, name: string, fallback: number): number {
  const v = args[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* ---------------- 文件类工具 ---------------- */

export const listFiles: Tool = {
  name: 'list_files',
  description: '列出工作区内某目录（含子目录，最多4层）的文件与文件夹。path 默认 "."。',
  params: [{ name: 'path', type: 'string', description: '工作区内相对路径，默认 "."', required: false }],
  execute(args, ctx) {
    const base = resolveSandboxPath(ctx.workspaceRoot, str(args, 'path', '.'));
    const lines: string[] = [];
    const walk = (dir: string, depth: number, rel: string) => {
      if (depth > 4 || lines.length > 300) return;
      let entries: Array<import('node:fs').Dirent>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0))) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (matchDenyPrefix(r, ctx.policy.readDenyPrefixes)) continue;
        if (e.isDirectory()) {
          lines.push(`d ${r}/`);
          walk(path.join(dir, e.name), depth + 1, r);
        } else {
          let size = 0;
          try {
            size = statSync(path.join(dir, e.name)).size;
          } catch {
            /* 忽略 */
          }
          lines.push(`f ${r} (${size}B)`);
        }
      }
    };
    walk(base, 0, '');
    return Promise.resolve({ ok: true, output: lines.length ? lines.join('\n') : '(空目录)' });
  },
};

export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取工作区内某个文本文件。返回带行号内容，最多 maxLines 行（默认 400）。',
  params: [
    { name: 'path', type: 'string', description: '工作区内相对路径' },
    { name: 'maxLines', type: 'number', description: '最多返回行数，默认400', required: false },
  ],
  execute(args, ctx) {
    const rel = str(args, 'path');
    const abs = resolveSandboxPath(ctx.workspaceRoot, rel);
    const relNorm = path.relative(path.resolve(ctx.workspaceRoot), abs).replace(/\\/g, '/');
    if (matchDenyPrefix(relNorm, ctx.policy.readDenyPrefixes)) {
      return Promise.resolve({ ok: false, output: `拒绝：该路径禁止读取（${relNorm}）`, rejected: true });
    }
    if (abs.endsWith('.png') || abs.endsWith('.jpg') || abs.endsWith('.exe') || abs.endsWith('.zip')) {
      return Promise.resolve({ ok: false, output: '拒绝：不支持读取二进制文件', rejected: true });
    }
    const max = num(args, 'maxLines', 400);
    const text = readFileSync(abs, 'utf-8');
    const lines = text.split(/\r?\n/);
    const head = lines.slice(0, max).map((l, i) => `${i + 1}: ${l}`);
    const tail = lines.length > max ? `\n…（共 ${lines.length} 行，已截断）` : '';
    return Promise.resolve({ ok: true, output: head.join('\n') + tail });
  },
};

export const searchCode: Tool = {
  name: 'search_code',
  description: '在工作区内按正则搜索文本（不递归 node_modules/.git），每命中一行输出 "相对路径:行号: 内容"。最多返回 80 行。',
  params: [
    { name: 'query', type: 'string', description: '搜索表达式（JavaScript 正则，按字符串字面搜索时对特殊字符转义）' },
    { name: 'glob', type: 'string', description: '文件名过滤，如 "*.ts"（默认全部文本文件）', required: false },
  ],
  execute(args, ctx) {
    const query = str(args, 'query');
    const glob = str(args, 'glob', '');
    let re: RegExp;
    try {
      re = new RegExp(query, 'i');
    } catch {
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const globRe = glob
      ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, ':::').replace(/\*/g, '[^/]*').replace(/:::/g, '.*').replace(/\?/g, '.') + '$', 'i')
      : null;
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      if (out.length > 80) return;
      let entries: Array<import('node:fs').Dirent>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (['node_modules', '.git', 'dist', 'build', '.runtime'].includes(e.name)) continue;
          walk(path.join(dir, e.name), r);
          continue;
        }
        if (globRe && !globRe.test(e.name)) continue;
        if (matchDenyPrefix(r, ctx.policy.readDenyPrefixes)) continue;
        let text = '';
        try {
          statSync(path.join(dir, e.name)).size;
          text = readFileSync(path.join(dir, e.name), 'utf-8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue; // 二进制
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            out.push(`${r}:${i + 1}: ${lines[i]!.trim().slice(0, 160)}`);
            if (out.length > 80) return;
          }
        }
      }
    };
    walk(ctx.workspaceRoot, '');
    return Promise.resolve({ ok: true, output: out.length ? out.join('\n') : '(无匹配)' });
  },
};

/** SEARCH/REPLACE 块补丁（模型友好、比 unified diff 好写对）
 * 格式：
 * path: 相对路径
 * =======
 * SEARCH原文（新建文件时留空）
 * =======
 * REPLACE原文
 * =======
 */
const PATCH_MARKER = /^path:\s*(?<path>[^\r\n]+)\r?\n(?:\r?\n)?={3,}\r?\n(?<search>[\s\S]*?)\r?\n?={3,}\r?\n(?<replace>[\s\S]*?)\r?\n?={3,}\s*$/;
/** 供协议层复用（隐蔽标记的补丁体解析） */
export { PATCH_MARKER };

export const applyPatch: Tool = {
  name: 'apply_patch',
  description:
    '修改（或创建）工作区内一个文件。格式：\npath: 相对路径\n=======\nSEARCH 原文（必须与文件现有内容完全一致；新建文件时留空）\n=======\nREPLACE 新原文\n=======\nSEARCH/REPLACE 两段请精确匹配，包含所有空格与换行；一次调用处理一个文件。',
  params: [
    { name: 'patch', type: 'string', description: '上面描述格式的补丁全文（JSON 转义后的字符串）' },
  ],
  /** 确认提示要足够具体：让操作者/审批模型能依据「实际改哪、改什么」做出判断 */
  confirmHint: (args) => {
    const raw = typeof args['patch'] === 'string' ? args['patch'] : '';
    const m = PATCH_MARKER.exec(raw.trim());
    if (!m || !m.groups) return '模型请求写入/修改文件（补丁格式异常，无法预览内容；执行时将被拒）';
    const rel = m.groups['path']!.trim();
    const search = m.groups['search']!.replace(/\r\n/g, '\n').replace(/^\n/, '').replace(/\n$/, '');
    const replace = m.groups['replace']!.replace(/\r\n/g, '\n').replace(/^\n/, '').replace(/\n$/, '');
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，原 ${s.length} 字符）` : s);
    if (!search.trim()) return `新建文件 ${rel}，完整内容为：\n${cut(replace, 500)}`;
    return `修改文件 ${rel}：\n[SEARCH 现在]：\n${cut(search, 300)}\n[REPLACE 改为]：\n${cut(replace, 300)}`;
  },
  execute(args, ctx) {
    const raw = str(args, 'patch');
    const m = PATCH_MARKER.exec(raw.trim());
    if (!m || !m.groups) {
      return Promise.resolve({ ok: false, output: '补丁格式错误：缺少 path:/SEARCH/REPLACE 标记。请严格按协议格式重发。', rejected: false });
    }
    const rel = m.groups['path']!.trim();
    const search = m.groups['search']!.replace(/\r\n/g, '\n');
    const replace = m.groups['replace']!.replace(/\r\n/g, '\n');
    let abs: string;
    try {
      abs = resolveSandboxPath(ctx.workspaceRoot, rel);
      const relNorm = path.relative(path.resolve(ctx.workspaceRoot), abs).replace(/\\/g, '/');
      if (matchDenyPrefix(relNorm, ctx.policy.writeDenyPrefixes)) {
        return Promise.resolve({ ok: false, output: `拒绝：该路径禁止写入（${relNorm}）。模型不得修改系统文件与配置。`, rejected: true });
      }
    } catch (e) {
      return Promise.resolve({ ok: false, output: e instanceof Error ? e.message : '路径校验失败', rejected: true });
    }
    const created = !existsSync(abs);
    const content = created ? '' : readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n');
    if (created) {
      if (search.trim() !== '') {
        return Promise.resolve({ ok: false, output: '新建文件时 SEARCH 块须为空字符串。', rejected: false });
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, replace.startsWith('\n') ? replace.slice(1) : replace, 'utf-8');
      return Promise.resolve({ ok: true, output: `已创建 ${rel}（${Buffer.byteLength(replace, 'utf-8')}B）` });
    }
    if (search.trim() === '') {
      // 追加到文件末尾
      writeFileSync(abs, content.endsWith('\n') ? content + replace : content + '\n' + replace, 'utf-8');
      return Promise.resolve({ ok: true, output: `已在 ${rel} 末尾追加 ${Buffer.byteLength(replace, 'utf-8')}B` });
    }
    const searchT = search.replace(/^\n/, '').replace(/\n$/, '');
    const replaceT = replace.replace(/^\n/, '').replace(/\n$/, '');
    if (!content.includes(searchT)) {
      return Promise.resolve({
        ok: false,
        output: '补丁失败，SEARCH 块与文件现有内容不完全一致。请先 read_file 获取精确内容（含空格与换行、行首行号请去掉），再重试。',
        rejected: false,
      });
    }
    writeFileSync(abs, content.replace(searchT, replaceT), 'utf-8');
    return Promise.resolve({ ok: true, output: `已修改 ${rel}（新大小 ${Buffer.byteLength(readFileSync(abs, 'utf-8'), 'utf-8')}B）` });
  },
};

/* ---------------- 命令类工具 ---------------- */

const FORBIDDEN_COMMAND_CHARS = /[;&|<>`]/;

/** 命令是否需要审批：仅在白名单内且标记 requireConfirm的高风险前缀返回提示 */
function highRiskCommandHint(cmd: string, ctx: ToolContext): string | null {
  const c = cmd.trim();
  if (!c || FORBIDDEN_COMMAND_CHARS.test(c)) return null; // 非法命令会被执行器拒绝，无需确认
  const hit = ctx.policy.commandWhitelistPrefixes.find((p) => commandMatchesPrefix(c, p.prefix));
  if (!hit || !hit.requireConfirm) return null;
  return `执行高风险命令（白名单 ${hit.prefix}）：${c}`;
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  const c = command.toLowerCase();
  const p = prefix.trim().toLowerCase();
  return c === p || c.startsWith(`${p} `);
}

function containsInlineInterpreterCode(command: string): boolean {
  return /^(?:node(?:\.exe)?|python(?:\.exe)?|python3(?:\.exe)?)(?:\s+)(?:-e|--eval|-c|--command)(?:\s|$)/i.test(command.trim());
}

function runCaptured(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 60_000) stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 30_000) stderr += d.toString();
    });
    child.on('error', (e: Error) => {
      clearTimeout(t);
      resolve({ code: null, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

export const runCommand: Tool = {
  name: 'run_command',
  description: '在任务工作区目录内执行命令（仅白名单前缀；install/commit 等会向你请求批准）。禁止管道/重定向/分号。',
  params: [{ name: 'command', type: 'string', description: '完整命令行，如 node test.js' }],
  confirmHint: (args, ctx) => highRiskCommandHint(str(args, 'command', ''), ctx),
  execute(args, ctx) {
    const cmd = str(args, 'command').trim();
    if (FORBIDDEN_COMMAND_CHARS.test(cmd)) {
      return Promise.resolve({ ok: false, output: '拒绝：命令包含禁止字符（; & | < > `）。请拆成多条命令分别执行。', rejected: true });
    }
    if (containsInlineInterpreterCode(cmd)) {
      return Promise.resolve({ ok: false, output: '拒绝：不允许通过 node/python 直接执行内联代码，请改用工作区内文件。', rejected: true });
    }
    const hit = ctx.policy.commandWhitelistPrefixes.find((p) => commandMatchesPrefix(cmd, p.prefix));
    if (!hit) {
      return Promise.resolve({ ok: false, output: `拒绝：命令前缀不在白名单。可用前缀：${ctx.policy.commandWhitelistPrefixes.map((p) => p.prefix).join('，')}`, rejected: true });
    }
    return (async () => {
      if (hit.requireConfirm && !ctx.skipConfirm) {
        const okGo = await ctx.confirm(`执行高风险命令：${cmd}`, cmd);
        if (!okGo) return { ok: false, output: '确认被拒绝（人工或审批模型）：命令未执行。', rejected: true } as ToolOutput;
      }
      const { code, stdout, stderr } = await runCaptured(cmd, ctx.workspaceRoot, 180_000);
      const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n…(截断，原 ${s.length} 字符)` : s);
      return {
        ok: code === 0,
        output: `exit=${code}\n--- stdout ---\n${trim(stdout, 6000)}\n--- stderr ---\n${trim(stderr, 3000)}`,
      };
    })();
  },
};

export const runBuild: Tool = {
  name: 'run_build',
  description: '执行构建命令（默认 "npm run build"，可传 command 覆盖）。',
  params: [{ name: 'command', type: 'string', description: '构建命令，默认 npm run build', required: false }],
  confirmHint: (args, ctx) => highRiskCommandHint(str(args, 'command', 'npm run build'), ctx),
  execute(args, ctx) {
    const cmd = str(args, 'command', 'npm run build');
    return runCommand.execute({ command: cmd }, ctx);
  },
};

export const runTests: Tool = {
  name: 'run_tests',
  description: '执行测试命令（默认 "npm test"，可传 command 覆盖，如 node test.js）。',
  params: [{ name: 'command', type: 'string', description: '测试命令，默认 npm test', required: false }],
  confirmHint: (args, ctx) => highRiskCommandHint(str(args, 'command', 'npm test'), ctx),
  execute(args, ctx) {
    const cmd = str(args, 'command', 'npm test');
    return runCommand.execute({ command: cmd }, ctx);
  },
};

export const gitDiff: Tool = {
  name: 'git_diff',
  description: '查看工作区 git 状态/差异（git_status / git_diff 二合一：status=true 只看状态）。',
  params: [{ name: 'status', type: 'boolean', description: '为 true 时执行 git status，否则 git diff', required: false }],
  async execute(args, ctx) {
    const wantStatus = args['status'] === true;
    const { code, stdout, stderr } = await runCaptured(
      wantStatus ? 'git status --short' : 'git diff --stat',
      ctx.workspaceRoot,
      60_000,
    );
    return { ok: code === 0, output: `exit=${code}\n${stdout || stderr}`.trim() };
  },
};

export const defaultTools: Tool[] = [listFiles, readFileTool, searchCode, applyPatch, runCommand, runBuild, runTests, gitDiff];
