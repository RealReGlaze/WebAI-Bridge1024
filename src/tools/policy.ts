/**
 * 安全沙箱与策略。
 * 原则：
 * - 模型的文件操作只能落在本任务工作区内（workspaceRoot 之外一律拒绝）。
 * - 模型不可修改桥接器自身与配置（deny 名单），也不可修改本策略文件。
 * - 策略文件只允许人工编辑；每次执行都从磁盘重新读取，模型虚假的"已修改策略"不生效。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface AgentPolicy {
  /** 工作区内禁止写入的模式（相对工作区根，glob 简化为前缀匹配） */
  writeDenyPrefixes: string[];
  /** 工作区内禁止读取/列目录的模式 */
  readDenyPrefixes: string[];
  /** 模型发出的命令中，这些前缀经人工确认后放行 */
  commandWhitelistPrefixes: { prefix: string; requireConfirm: boolean }[];
}

export const DEFAULT_POLICY: AgentPolicy = {
  writeDenyPrefixes: ['.runtime/', 'config/', 'docs/', '../'],
  readDenyPrefixes: ['.runtime/sessions/', '.runtime/tasks/'],
  commandWhitelistPrefixes: [
    { prefix: 'node', requireConfirm: true },
    { prefix: 'npm run', requireConfirm: false },
    { prefix: 'npm test', requireConfirm: false },
    { prefix: 'npm.cmd run', requireConfirm: false },
    { prefix: 'npm.cmd test', requireConfirm: false },
    { prefix: 'npx.cmd tsc', requireConfirm: false },
    { prefix: 'npm run', requireConfirm: false },
    { prefix: 'npm test', requireConfirm: false },
    { prefix: 'npx tsc', requireConfirm: false },
    { prefix: 'npx tsx', requireConfirm: false },
    { prefix: 'git status', requireConfirm: false },
    { prefix: 'git diff', requireConfirm: false },
    { prefix: 'git log', requireConfirm: false },
    { prefix: 'python', requireConfirm: true },
    { prefix: 'pip', requireConfirm: true },
    { prefix: 'npm install', requireConfirm: true },
    { prefix: 'npm ci', requireConfirm: true },
    { prefix: 'npm.cmd install', requireConfirm: true },
    { prefix: 'git commit', requireConfirm: true },
    { prefix: 'git push', requireConfirm: true },
  ],
};

export const POLICY_FILENAME = '.agent-policy.json';

export function loadPolicy(baseDir: string): AgentPolicy {
  // 优先级：工作区内的 .agent-policy.json > 项目 config/ 下的同名文件 > 默认
  const candidates = [
    path.join(baseDir, POLICY_FILENAME),
    path.resolve(process.cwd(), 'config', POLICY_FILENAME),
  ].filter((p) => existsSync(p));
  if (candidates.length > 0) {
    try {
      const raw = JSON.parse(readFileSync(candidates[0]!, 'utf-8')) as Partial<AgentPolicy>;
      return {
        ...DEFAULT_POLICY,
        ...raw,
        commandWhitelistPrefixes: raw.commandWhitelistPrefixes ?? DEFAULT_POLICY.commandWhitelistPrefixes,
      };
    } catch {
      // 策略文件损坏时退回默认（安全优先）
    }
  }
  return DEFAULT_POLICY;
}

/** 校验模型给出的路径合法且落在 baseDir 内；返回绝对路径或抛错 */
export function resolveSandboxPath(baseDir: string, userPath: string): string {
  const trimmed = (userPath ?? '').trim();
  if (!trimmed || trimmed.includes('\u0000')) throw new Error('路径无效');
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(baseDir, trimmed);
  const baseResolved = path.resolve(baseDir);
  const rel = path.relative(baseResolved, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越权：${userPath} 不在工作区 ${baseResolved} 内`);
  }
  // 词法路径检查无法阻止工作区内的 symlink/junction 指向外部目录。
  // 对目标自身（或最近存在的祖先）做 realpath 校验；基目录尚不存在时（如沙箱首建），
  // 也上溯到其最近存在的祖先再对比，仍能拦截通过已存在链接指向外部的越权。
  {
    let probe = absolute;
    let probeBase = baseResolved;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    while (!existsSync(probeBase)) {
      const parent = path.dirname(probeBase);
      if (parent === probeBase) break;
      probeBase = parent;
    }
    let realBase: string;
    let realProbe: string;
    try {
      realBase = realpathSync.native(probeBase);
      realProbe = realpathSync.native(probe);
    } catch {
      throw new Error(`路径校验失败：无法确认 ${userPath} 的真实位置`);
    }
    const realRel = path.relative(realBase, realProbe);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`路径越权：${userPath} 通过链接指向工作区外`);
    }
  }
  return absolute;
}

/** 检查相对路径是否命中禁止模式 */
export function matchDenyPrefix(relPath: string, prefixes: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  return prefixes.some((p) => {
    const np = p.replace(/\\/g, '/').toLowerCase();
    if (np.endsWith('/')) return normalized.startsWith(np) || normalized === np.slice(0, -1);
    return normalized === np || normalized.startsWith(np + '/');
  });
}
