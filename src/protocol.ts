/**
 * 统一工具调用协议（对非函数调用式的网页模型设计）。
 *
 * 标准调用块（渲染安全）：
 *    ⟦TOOLCALL⟧{"name":"工具名","args":{...}}⟦/TOOLCALL⟧
 * ---- 标准调用块（渲染安全）----
 * 模型也可用 DeepSeek 原生 DSML 模板，解析前会被 normalizeDeepSeekCalls 归一化。
 * 结束任务：<finish>总结</finish>
 */
import { defaultTools, type Tool } from './tools/index.js';
import type { ToolOutput } from './tools/index.js';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
}

export interface ParsedReply {
  calls: ToolCall[];
  finish: string | null;
  /** 解析/校验失败信息（需要反馈给模型重发） */
  errors: string[];
  /** 模型自声明的工作模式（首选回复内 <mode>ask|work</mode> 或 [MODE:ask]） */
  mode?: 'ask' | 'work';
}

/** 标准块围栏（```toolcall）作为后备入口 */
export const TOOL_BLOCK_START = String.fromCharCode(96, 96, 96) + 'toolcall';
export const TOOL_BLOCK_END = String.fromCharCode(96, 96, 96);

/** 标准块标记（不会被 markdown 渲染器转换，绕过"复制/下载"按钮吞标记的问题） */
export const CANON_START = '\u27E6TOOLCALL\u27E7';
export const CANON_END = '\u27E6/TOOLCALL\u27E7';

/** raw 多行参数标记：代码类参数不需要任何转义 */
export const ARG_START_PREFIX = '\u27E6ARG ';
/** 参数名与开标记的收尾（⟦ARG name⟧） */
export const ARG_END_MARKUP = '\u27E7';
export const ARG_END = '\u27E6/ARG\u27E7';

export const FINISH_START = '<finish>';
export const FINISH_END = '</finish>';

/** 隐蔽自然语调用标记（首选协议）：网页对话里不显眼，但 Harness 可靠识别。
 *  模型用 [中文短语]（或全角 【】）表达一次调用；参数写在下一行起，格式 `键：值`；[收工] = 完成任务。 */
export const COVERT_TOKENS: Record<string, string> = {
  '查查目录': 'list_files',
  '翻看文件': 'read_file',
  '搜个关键词': 'search_code',
  '改改这里': 'apply_patch',
  '跑个小命令': 'run_command',
  '构建一下': 'run_build',
  '测一测': 'run_tests',
  '对比改动': 'git_diff',
};
/** 完成标记（隐蔽） */
export const COVERT_FINISH = '收工';
/** 中文参数键 → 工具参数名（键值解析时归一） */
export const COVERT_KEYS: Record<string, string> = {
  '路径': 'path', '目录': 'path', '文件': 'path',
  '命令': 'command',
  '补丁': 'patch', '内容': 'patch',
  '查询': 'query', '关键词': 'query', '正则': 'query',
  '过滤': 'glob', '文件名': 'glob',
  '最多行数': 'maxLines', 'status': 'status', '状态': 'status',
};

export function toolCatalog(tools: Tool[] = defaultTools): string {
  return tools
    .map(
      (t) =>
        `- ${t.name}(${t.params
          .map((p) => `${p.name}${p.required === false ? '?' : ''}:${p.type}`)
          .join(', ')}): ${t.description}`,
    )
    .join('\n');
}

export function buildSystemMessage(goal: string, workspaceRoot: string, tools: Tool[] = defaultTools): string {
  return [
    '你是本地代码开发助理。你的推理在网页端完成，所有文件与命令操作都由本地 Harness 代为执行。',
    '你只能通过下方协议提交操作请求，绝不能在自己回复里声称"已修改/已测试成功"——只有收到 <tool_result> 才算真实结果。',
    '',
    '# 任务目标（用户）',
    goal,
    '',
    '# 工作区',
    `本地目录：${workspaceRoot}`,
    '你的一切文件路径都必须相对这个目录（或以它开头的绝对路径），越权路径会被拒绝。',
    '',
    '# 可用工具',
    toolCatalog(tools),
    '',
    '# 调用协议（首选：隐蔽自然语标记）---- 严格遵守，参数值不需要任何转义 ----',
    '需要操作时，在回复中输出下面的自然语标记；Harness 会识别并只回传真实结果。',
    '',
    '| 标记 | 对应操作 |',
    '|---|---|',
    '| [查查目录] | list_files 列目录 |',
    '| [翻看文件] | read_file 读文件 |',
    '| [搜个关键词] | search_code 搜索 |',
    '| [改改这里] | apply_patch 修改/新建文件 |',
    '| [跑个小命令] | run_command 执行命令 |',
    '| [构建一下] | run_build 构建 |',
    '| [测一测] | run_tests 测试 |',
    '| [对比改动] | git_diff 查看差异 |',
    '| [收工] 一两句总结 | 结束任务 |',
    '',
    '参数规则：标记的下一行起写参数，格式 `参数名: 值`（中英文冒号均可，参数名可用中文：路径/命令/查询/过滤/补丁）。',
    '示例 A（列目录）：',
    '[查查目录]',
    '路径: src/runtime',
    '',
    '示例 B（读文件）：',
    '[翻看文件]',
    '路径: README.md',
    '',
    '示例 C（补丁，原样写不需要转义；SEARCH 与文件现有内容逐字一致，新建文件时两条 ======= 之间留空）：',
    '[改改这里]',
    'path: 相对路径',
    '=======',
    'SEARCH 原文',
    '=======',
    'REPLACE 新原文',
    '=======',
    '',
    '示例 D（结束）：[收工] 已创建 fib.ts 并通过测试。',
    '也可以省略参数行直接把单个值写在标记后同一行，如 [查查目录] src（等价于 路径: src）。',
    '',
    '# 备用调用块（标准标记；优先级低于上面的隐蔽标记）',
    '1. 需要时回复中输出一个或多个调用块，格式：',
    '',
    `${CANON_START}name: 工具名`,
    `${ARG_START_PREFIX}参数名${ARG_END_MARKUP}`,
    '参数值写在下一行开始（单行参数就写一行；多行参数写多行）',
    ARG_END,
    CANON_END,
    '',
    `   每个参数一对标记——开 ${ARG_START_PREFIX}参数名${ARG_END_MARKUP} 与 ${ARG_END}，参数值写在它们之间（下一行开始），无需 \\n 或 \\" 转义，直接原样写。`,
    '2. apply_patch 也可用标准块，patch 参数格式与上面 [改改这里] 完全一致（path: / ======= / ======= / =======）。',
    '3. 其它工具：list_files 的 path 可写 "."；read_file 只需 path；run_tests / run_command 的 command 写 "node fib.test.ts" 这样一行。',
    '4. <tool_result> 会以编号实时回传每个调用的真实结果（stdout/错误/拒绝原因）。收到结果后再决定下一步。',
    '5. 全部完成后输出 [收工] 总结（或 <finish>一两句话总结</finish>），不再提交新调用块。',
    '6. ok=false 且语义含"拒绝"时不要原样重试；纠正或 <finish> 说明受阻原因。',
    '7. 需要操作就必须真的输出调用块，不能只在文字里说"我将要执行"。',
    '   你也可以用你的原生调用模板（invoke/parameter），Harness 两种都识别。',
    '8. 严格禁止用 run_command 启动 webai/webai.cmd 本身或任何嵌套 Agent 任务（会被环境守卫拒绝）。',
    '   了解目录/文件用 list_files 与 read_file 即可，不需要也不允许递归调用本系统。',
    '',
    '# 工作模式（首轮回复必须先声明）',
    '首轮回复第一行声明：<mode>ask</mode> 或 <mode>work</mode>',
    '- ask：一次性问答/查询/分析（1~3 个输入就能答完的任务；优先直接给结论，最多两小批调用）。',
    '- work：需要多轮创建/修改/构建/测试的实际执行任务。',
    '声明后按对应节律推进：ask 快进快出，work 稳步多轮。声明只需一次。',
    '',
    '现在开始：先声明工作模式，然后了解任务与工作区（可用 list_files / read_file），再执行目标。',
  ].join('\n');
}

/** DeepSeek 原生 DSML 调用块 → 标准块。页面渲染吞围栏，模型原生模板用全角竖线 U+FF5C。 */
export function normalizeDeepSeekCalls(text: string): string {
  const pattern =
    '<\\uFF5C\\uFF5CDSML\\uFF5C\\uFF5C invoke name="([a-zA-Z_]+)">[\\s\\S]*?<\\/\\uFF5C\\uFF5CDSML\\uFF5C\\uFF5C invoke>';
  const mainRe = new RegExp(pattern, 'g');
  // 逐参数形状：<…parameter name="X" string="true">值</…parameter>
  const paramRe = new RegExp('<\\uFF5C\\uFF5CDSML\\uFF5C\\uFF5C parameter name="([a-zA-Z_]+)"( string="[^"]*")?[^>]*>([\\s\\S]*?)<\\/\\uFF5C\\uFF5CDSML\\uFF5C\\uFF5C parameter>', 'g');
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = mainRe.exec(text)) !== null) {
    const name = m[1]!;
    const inner = m[0];
    const args: Record<string, unknown> = {};
    let bad = false;
    let pm: RegExpExecArray | null;
    paramRe.lastIndex = 0;
    while ((pm = paramRe.exec(inner)) !== null) {
      const key = pm[1]!;
      const isRaw = (pm[2] ?? '') === ' string="true"';
      if (isRaw) {
        args[key] = pm[3]!;
        continue;
      }
      try {
        args[key] = JSON.parse(pm[3]!);
      } catch {
        args[key] = pm[3]!;
      }
    }
    // 旧形状：单个 args 参数（JSON.parse 已在 paramRe 中完成）→ 展开其键
    if (!bad && args['args'] && typeof args['args'] === 'object' && args['args'] !== null && Object.keys(args).length === 1) {
      const nested = args['args'] as Record<string, unknown>;
      delete args['args'];
      Object.assign(args, nested);
    }
    if (bad || (Object.keys(args).length === 0 && !inner.includes('parameter'))) {
      parts.push(CANON_START + JSON.stringify({ name: '__parse_error__', args: { error: 'invoke 参数解析失败' } }) + CANON_END);
      continue;
    }
    parts.push(CANON_START + JSON.stringify({ name, args }) + CANON_END);
  }
  if (parts.length === 0) return text;
  console.log('[protocol] 检测到模型原生 DSML 调用，已标准化。');
  return text + '\n' + parts.join('\n');
}

/** 校验 name+args → ToolCall（未知工具/缺参数记 errors） */
function validateAndBuild(name: string, args: Record<string, unknown>, raw: string, tools: Tool[], errors: string[]): ToolCall | null {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    errors.push(`未知工具名：${name}。可用：${tools.map((t) => t.name).join(', ')}`);
    return null;
  }
  for (const p of tool.params) {
    if (p.required === false) continue;
    if (!(p.name in args)) errors.push(`工具 ${name} 缺少必需参数 ${p.name}。`);
  }
  return { name, args, raw };
}

/** 隐蔽标记解析：[中文短语] / 【中文短语】 → 工具调用；参数体在同一标记之后的文本里。
 *  体解析优先级：① 含 =======（补丁）→ 整体按 SEARCH/REPLACE 补丁格式；② `键: 值` 行（中英冒号、中英键）；
 *  ③ 单行短值 → 直接作为该工具的第一个参数（list_files→path 等）。 */
function parseCovert(text: string, tools: Tool[], errors: string[]): { calls: ToolCall[]; finish: { text: string } | null } {
  const tokenRe = /[【\[]\s*([^\]】]{1,12})\s*[\]】]/g;
  type Hit = { start: number; token: string; name: string | null; isFinish: boolean };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const tok = m[1]!.trim();
    const tool = COVERT_TOKENS[tok];
    if (!tool && tok !== COVERT_FINISH) continue;
    hits.push({ start: m.index, token: tok, name: tool ?? null, isFinish: tok === COVERT_FINISH });
  }
  const calls: ToolCall[] = [];
  let finish: { text: string } | null = null;
  for (let h = 0; h < hits.length; h++) {
    const hit = hits[h]!;
    const open = text[hit.start]!; // '[' 或 '【'
    const close = open === '【' ? '】' : ']';
    const closeIdx = text.indexOf(close, hit.start);
    const after = closeIdx + 1;
    const bodyEnd = h + 1 < hits.length ? hits[h + 1]!.start : text.length;
    const body = text.slice(after, bodyEnd).trim();
    if (hit.isFinish) {
      finish = { text: body.replace(/\s+/g, ' ').trim() };
      continue;
    }
    if (!body) {
      const call = validateAndBuild(hit.name!, {}, hit.token, tools, errors);
      if (call) calls.push(call);
      continue;
    }
    // ① 补丁体：整体按 SEARCH/REPLACE 处理
    if (/={3,}/.test(body) && /path\s*[:：]/.test(body)) {
      const call = validateAndBuild(hit.name!, { patch: body.replace(/\r\n/g, '\n') }, hit.token, tools, errors);
      if (call) calls.push(call);
      continue;
    }
    // ② 键值行：键可中文 → 归一为工具参数名；键必须是工具声明过的参数，避免把普通句子误判为参数
    const tool = tools.find((t) => t.name === hit.name);
    const args: Record<string, unknown> = {};
    for (const line of body.split(/\r?\n/)) {
      const kv = /^\s*([^\s:：]{1,16})\s*[:：]\s*(.+?)\s*$/.exec(line);
      if (!kv) continue;
      const en = COVERT_KEYS[kv[1]!] ?? kv[1]!;
      if (!tool || !tool.params.some((p) => p.name === en)) continue;
      args[en] = kv[2]!;
    }
    if (Object.keys(args).length > 0) {
      const call = validateAndBuild(hit.name!, args, hit.token, tools, errors);
      if (call) calls.push(call);
      continue;
    }
    // ③ 单行/纯文本 → 工具声明的第一个参数
    const firstParam = tool?.params[0]?.name;
    const call = validateAndBuild(hit.name!, firstParam ? { [firstParam]: body.replace(/\s+/g, ' ') } : {}, hit.token, tools, errors);
    if (call) calls.push(call);
  }
  return { calls, finish };
}
function buildCall(raw: string, tools: Tool[], errors: string[]): ToolCall | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (je) {
    errors.push(
      `调用块 JSON 解析失败：${je instanceof Error ? je.message : String(je)}。原片段开头：${raw.slice(0, 80).replace(/\s+/g, ' ')}`,
    );
    return null;
  }
  if (typeof obj !== 'object' || obj === null) {
    errors.push('调用块内容必须是 JSON 对象。');
    return null;
  }
  const record = obj as { name?: unknown; args?: unknown };
  if (typeof record.name !== 'string') {
    errors.push('调用块缺少字符串 "name" 字段。');
    return null;
  }
  const argObj: Record<string, unknown> =
    typeof record.args === 'object' && record.args !== null ? (record.args as Record<string, unknown>) : {};
  return validateAndBuild(record.name, argObj, raw, tools, errors);
}

/** raw 参数块（无需 JSON 转义）解析。
 *  变体①：块体首行就是已知的工具名（⟦TOOLCALL⟧list_files 提取后 body 以 "list_files" 开头）；
 *  变体②：name: 工具名 行；随后 ⟦ARG 参数⟧…⟦/ARG⟧ 对，值在下一行开始。 */
function parseRawBlock(raw: string, tools: Tool[], errors: string[]): ToolCall | null {
  const t = raw.trim();
  const firstLine = t.split('\n', 1)[0] ?? '';
  let name: string | null = null;
  const nameMatch = /^name\s*[:=：]\s*([A-Za-z_]\w*)/.exec(firstLine);
  const bareTool = /^([A-Za-z_]\w*)\s*$/.exec(firstLine);
  if (nameMatch) {
    name = nameMatch[1]!;
  } else if (bareTool && tools.some((tt) => tt.name === bareTool[1]!)) {
    name = bareTool[1]!;
  } else if (tools.some((tt) => tt.name === firstLine.trim())) {
    name = firstLine.trim();
  }
  if (!name) {
    errors.push(`调用块缺少工具名（"name: 工具名" 行或首行直接写工具名）。原片段开头：${t.slice(0, 80).replace(/\s+/g, ' ')}`);
    return null;
  }
  const args: Record<string, unknown> = {};
  // 参数解析（自适应）：
  //   规范写法：⟦ARG name⟧\n值...⟦/ARG⟧（值可多行，代码原样保留换行）
  //   模型漏写收尾：...⟦ARG name2⟧...（上一个参数值顺延到下一个开标记处自动闭合）
  //   行内写法：⟦ARG name⟧值 同行接值
  // 值边界 = min(下一个 ⟦ARG⟧ 开标记起点, 下一个 ⟦/ARG⟧, 块尾)
  const markerRe = new RegExp(ARG_START_PREFIX + '([A-Za-z_][\\w]*)' + ARG_END_MARKUP, 'g');
  const markers: Array<{ name: string; mStart: number; vStart: number }> = [];
  let mm: RegExpExecArray | null;
  while ((mm = markerRe.exec(t)) !== null) {
    markers.push({ name: mm[1]!, mStart: mm.index, vStart: mm.index + mm[0].length });
  }
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i]!;
    let end = t.indexOf(ARG_END, cur.vStart);
    if (end === -1) end = t.length;
    if (i + 1 < markers.length) end = Math.min(end, markers[i + 1]!.mStart);
    const value = t.slice(cur.vStart, end).replace(/^\r?\n/, '').trim();
    if (!(cur.name in args)) args[cur.name] = value;
  }
  return validateAndBuild(name, args, t, tools, errors);
}

/** 块体自适应：JSON 优先（能解析就用 JSON 校验并给出准确错误），否则走 raw 块解析 */
function parseBlockBody(body: string, tools: Tool[], errors: string[]): ToolCall | null {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    let jsonOk = false;
    try {
      JSON.parse(trimmed);
      jsonOk = true;
    } catch {
      /* 非 JSON：走 raw 块 */
    }
    if (jsonOk) return buildCall(trimmed, tools, errors);
  }
  return parseRawBlock(trimmed, tools, errors);
}

export function parseReply(text0: string, tools: Tool[] = defaultTools): ParsedReply {
  const text = normalizeDeepSeekCalls(text0);
  const errors: string[] = [];
  const calls: ToolCall[] = [];
  let finish: string | null = null;

  // 工作模式自声明：<mode>ask|work</mode>（首选）或 [MODE:ask]（宽松）
  let mode: 'ask' | 'work' | undefined;
  const modeM = /<mode>\s*(ask|work)\s*<\/mode>/i.exec(text) ?? /\[MODE[:：]\s*(ask|work)\s*\]/i.exec(text);
  if (modeM) mode = modeM[1]!.toLowerCase() as 'ask' | 'work';

  const finishIdx = text.indexOf(FINISH_START);
  if (finishIdx !== -1) {
    const endIdx = text.indexOf(FINISH_END, finishIdx);
    finish =
      endIdx !== -1
        ? text.slice(finishIdx + FINISH_START.length, endIdx).trim()
        : text.slice(finishIdx + FINISH_START.length).trim();
  }

  // 双入口扫描：标准标记块 与 ```toolcall 围栏块
  const raws: string[] = [];
  let idx = 0;
  for (;;) {
    const s = text.indexOf(CANON_START, idx);
    if (s === -1) break;
    const bs = s + CANON_START.length;
    const e = text.indexOf(CANON_END, bs);
    if (e === -1) {
      errors.push('标准调用块缺少结束标记，JSON 可能被截断，请重发。');
      break;
    }
    raws.push(text.slice(bs, e));
    idx = e + CANON_END.length;
  }
  idx = 0;
  for (;;) {
    const s = text.indexOf(TOOL_BLOCK_START, idx);
    if (s === -1) break;
    const bs = s + TOOL_BLOCK_START.length;
    const e = text.indexOf(TOOL_BLOCK_END, bs);
    if (e === -1) {
      errors.push('围栏调用块缺少结束围栏，JSON 可能被截断，请重发。');
      break;
    }
    raws.push(text.slice(bs, e));
    idx = e + TOOL_BLOCK_END.length;
  }
  for (const raw of raws) {
    const call = parseBlockBody(raw, tools, errors);
    if (call) calls.push(call);
  }

  // 第三入口：隐蔽自然语标记（[查查目录] 等；与标准标记互不干扰，混合使用也识别）
  const covert = parseCovert(text, tools, errors);
  for (const call of covert.calls) calls.push(call);
  if (!finish && covert.finish && covert.finish.text) finish = covert.finish.text;

  return { calls, finish, errors, mode };
}

export function buildToolResultMessage(results: Array<{ name: string; result: ToolOutput }>): string {
  const parts = results.map((r, i) => {
    const out = r.result.output.replace(/\r\n/g, '\n').trim();
    return `<tool_result name="${r.name}" ok="${r.result.ok}" seq="${i + 1}">\n${out}\n</tool_result>`;
  });
  return `# 本地执行结果（真实输出）\n${parts.join('\n\n')}\n\n请基于以上结果继续：提交下一批调用块、纠正参数，或输出 <finish>。`;
}

export function buildRetryMessage(errors: string[]): string {
  return `# 协议校验失败（本地 Harness 未执行任何工具）\n${errors.join('\n')}\n请重新输出完整有效的调用块。`;
}
