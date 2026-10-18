/**
 * 冒烟测试：纯本地，不依赖网页。
 *   npx.cmd tsx scripts/smoke.ts
 */
import { rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseReply, buildToolResultMessage, buildRetryMessage } from '../src/protocol.js';
import { DeepSeekWebAdapter } from '../src/adapters/DeepSeekWebAdapter.js';
import { applyPatch, runCommand, defaultTools } from '../src/tools/index.js';
import { resolveSandboxPath, DEFAULT_POLICY } from '../src/tools/policy.js';
import type { ToolContext } from '../src/tools/index.js';

const pass = (n: string) => console.log(`✅ ${n}`);
const fail = (n: string, msg = '') => {
  console.error(`❌ ${n} ${msg}`);
  process.exitCode = 1;
};

function main() {
  const sandbox = path.resolve('sandbox-tasks', 'smoke');
  rmSync(sandbox, { recursive: true, force: true });
  const ctx: ToolContext = {
    workspaceRoot: sandbox,
    policy: DEFAULT_POLICY,
    confirm: async () => true,
  };

  // 1. 补丁：新建文件（以下异步执行）
  void (async () => {
    const v1 = await applyPatch.execute(
      { patch: 'path: hello.ts\n=======\n\n=======\nexport const add = (a: number, b: number) => a + b;\n======' },
      ctx,
    );
    v1.ok && existsSync(path.join(sandbox, 'hello.ts')) ? pass('apply_patch 新建') : fail('apply_patch 新建', v1.output);

    // 2. 修改文件：SEARCH 匹配
    const v2 = await applyPatch.execute(
      {
        patch:
          'path: hello.ts\n=======\nexport const add = (a: number, b: number) => a + b;\n=======\nexport const add = (a: number, b: number) => a + b + 1;\n=======',
      },
      ctx,
    );
    const content = readFileSync(path.join(sandbox, 'hello.ts'), 'utf-8');
    v2.ok && content.includes('a + b + 1') ? pass('apply_patch 修改') : fail('apply_patch 修改', v2.output);

    // 3. SEARCH 不匹配 → 拒绝
    const v3 = await applyPatch.execute(
      {
        patch:
          'path: hello.ts\n=======\n不存在的原文\n=======\nx\n=======',
      },
      ctx,
    );
    !v3.ok && v3.output.includes('不完全一致') ? pass('apply_patch 失配拒绝') : fail('apply_patch 失配拒绝', v3.output);

    // 4. 越权路径拒绝
    try {
      resolveSandboxPath(sandbox, '../outside.txt');
      fail('路径越权拦截');
    } catch {
      pass('路径越权拦截');
    }

    // 5. deny 名单（node_modules 与系统路径）
    const v5 = await applyPatch.execute(
      { patch: 'path: ../config/backends.json\n=======\n\n=======\nhack\n======' },
      ctx,
    );
    !v5.ok ? pass('越权写入拒绝') : fail('越权写入拒绝');

    // 6. 命令：禁止字符
    const v6 = await runCommand.execute({ command: 'echo hi > x.txt & echo pwn' }, ctx);
    !v6.ok && v6.output.includes('禁止') ? pass('命令危险字符拦截') : fail('命令危险字符拦截', v6.output);

    // 7. 命令：白名单外
    const v7 = await runCommand.execute({ command: 'regedit' }, ctx);
    !v7.ok && v7.output.includes('白名单') ? pass('命令白名单拦截') : fail('命令白名单拦截', v7.output);

    // 8. 命令：白名单内真实执行
    const v8 = await runCommand.execute({ command: 'node -e "console.log(42)"' }, ctx);
    v8.ok && v8.output.includes('42') ? pass('命令白名单放行') : fail('命令白名单放行', v8.output);

    // 9. 协议解析：正常块 + finish
    const sample = '我先创建文件。\n```toolcall\n{"name":"apply_patch","args":{"patch":"path: a.txt\\n=======\\n\\n=======\\nhi\\n======"}}\n```\n然后结束。\n<finish>完成创建</finish>';
    const p1 = parseReply(sample, defaultTools);
    p1.errors.length === 0 && p1.calls.length === 1 && p1.finish === '完成创建'
      ? pass('协议解析（正常）')
      : fail('协议解析（正常）', JSON.stringify(p1));

    // 10. 协议解析：截断块 + 坏 JSON + 未知工具
    const sample2 = '```toolcall\n{"name":"apply_pat\n<finish>x</finish>';
    const p2 = parseReply(sample2, defaultTools);
    p2.errors.length >= 1 && p2.finish === 'x' ? pass('协议解析（错误上报）') : fail('协议解析（错误上报）', JSON.stringify(p2));

    // 11. 结果消息构造
    const m = buildToolResultMessage([
      { name: 'apply_patch', result: { ok: true, output: '已创建 a.txt（3B）' } },
    ]);
    m.includes('<tool_result name="apply_patch" ok="true" seq="1">') ? pass('结果回传消息') : fail('结果回传消息', m);
    const m2 = buildRetryMessage(['测试错误A']);
    m2.includes('重新输出') ? pass('重试消息') : fail('重试消息', m2);

    // 12. raw 参数块：含未转义双引号/井号的代码也应成功
    const rawBlock =
      '\u27E6TOOLCALL\u27E7name: apply_patch\n\u27E6ARG patch\u27E7\npath: fib.ts\n=======\n\n=======\nexport function fib(n: number): number {\n  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {\n    throw new TypeError("n must be a non-negative integer");\n  }\n}\n=======\n\u27E6/ARG\u27E7\u27E6/TOOLCALL\u27E7';
    const p3 = parseReply('说明文字\n' + rawBlock, defaultTools);
    const call3 = p3.calls[0];
    p3.errors.length === 0 && call3
      ? pass('raw 参数块解析')
      : fail('raw 参数块解析', JSON.stringify(p3.errors));

    // 13. raw 参数块内容逐字符保留（含双引号）
    call3 ? void call3 : null;
    if (call3 && String(call3.args['patch']).includes('throw new TypeError("n must be a non-negative integer")')) {
      pass('raw 参数内容保真');
    } else {
      fail('raw 参数内容保真', call3 ? String(call3.args['patch']).slice(0, 100) : '(no call)');
    }

    // 14. DSML 原生模板（逐参数形状，string="true"）归一化
    const P = '\uFF5C';
    const dsml =
      `<${P}${P}DSML${P}${P} calls>\n<${P}${P}DSML${P}${P} invoke name="apply_patch">\n<${P}${P}DSML${P}${P} parameter name="args" string="false">{"patch":"path: x.ts\\n======="}</${P}${P}DSML${P}${P} parameter>\n</${P}${P}DSML${P}${P} invoke>\n</${P}${P}DSML${P}${P} calls>`;
    const p4 = parseReply(dsml, defaultTools);
    p4.errors.length === 0 && p4.calls.length === 1 && p4.calls[0]?.name === 'apply_patch'
      ? pass('DSML args 形状归一化')
      : fail('DSML args 形状归一化', JSON.stringify(p4.errors) + JSON.stringify(p4.calls));

    // 15. DSML 逐参数形状（真实失败 Round12 形状）
    const dsml2 =
      `<${P}${P}DSML${P}${P} calls>\n<${P}${P}DSML${P}${P} invoke name="list_files">\n<${P}${P}DSML${P}${P} parameter name="path" string="true">.</${P}${P}DSML${P}${P} parameter>\n</${P}${P}DSML${P}${P} invoke>\n</${P}${P}DSML${P}${P} calls>`;
    const p5 = parseReply(dsml2, defaultTools);
    p5.errors.length === 0 && p5.calls.length === 1 && p5.calls[0]?.name === 'list_files'
      ? pass('DSML 逐参数形状归一化')
      : fail('DSML 逐参数形状归一化', JSON.stringify(p5.errors) + JSON.stringify(p5.calls));

    // 16. 真实回归：空 SEARCH 段（连续两条 =======）双分隔线补丁
    const realPatch =
      'path: fib.ts\n=======\n=======\nexport function fib(n: number): number {\n  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {\n    throw new TypeError("n must be a non-negative integer");\n  }\n  let a = 0;\n  return a;\n}\n=======';
    const v16 = await applyPatch.execute({ patch: realPatch }, ctx);
    v16.ok && existsSync(path.join(sandbox, 'fib.ts')) ? pass('空 SEARCH 段补丁(真实回归)') : fail('空 SEARCH 段补丁(真实回归)', v16.output);

    // 17. 真实回归：模型省略 name: 前缀（⟦TOOLCALL⟧list_files 直跟工具名）
    const p6 = parseReply('⟦TOOLCALL⟧list_files\n⟦ARG path⟧\n.\n⟦/ARG⟧⟦/TOOLCALL⟧', defaultTools);
    p6.errors.length === 0 && p6.calls[0]?.name === 'list_files' ? pass('无 name: 前缀块') : fail('无 name: 前缀块', JSON.stringify(p6));
    void p6;

    // 17b. 回归（2026-10-18 真实失败）：参数漏写 ⟦/ARG⟧ 收尾 + 行内接值
    const leakParsed = parseReply(
      '⟦TOOLCALL⟧name: read_file\n⟦ARG path⟧README.md\n⟦ARG maxLines⟧ 80\n⟦/TOOLCALL⟧',
      defaultTools,
    );
    const leakCall = leakParsed.calls[0];
    const leakOk =
      leakCall?.name === 'read_file' &&
      leakCall.args['path'] === 'README.md' &&
      leakCall.args['maxLines'] === '80' &&
      leakParsed.errors.length === 0;
    leakOk ? pass('自适应参数解析（漏写收尾+行内值）') : fail('自适应参数解析（漏写收尾+行内值）', JSON.stringify(leakParsed));

    // 17c. 回归：规范多行写法不受自适应解析影响（代码原样保留换行）
    const multilineParsed = parseReply(
      '⟦TOOLCALL⟧name: apply_patch\n⟦ARG patch⟧\npath: a.txt\n=======\nBienvenue\n=======\n⟦/ARG⟧\n⟦/TOOLCALL⟧',
      defaultTools,
    );
    const patchArg = multilineParsed.calls[0]?.args['patch'];
    const multilineOk =
      typeof patchArg === 'string' &&
      patchArg.startsWith('path: a.txt\n=======\nBienvenue') &&
      !patchArg.includes('⟦');
    multilineOk ? pass('多行参数内容保真（自适应解析后）') : fail('多行参数内容保真（自适应解析后）', JSON.stringify(patchArg));

    // 17d. 模式自声明解析（ask/work）
    const modeParsed = parseReply('<mode>ask</mode>\n答案是 4。', defaultTools);
    const modeWork = parseReply('[MODE: work]\n嗯。', defaultTools);
    const modeOk = modeParsed.mode === 'ask' && modeWork.mode === 'work';
    modeOk ? pass('模式自声明解析（<mode>/[MODE:]）') : fail('模式自声明解析（<mode>/[MODE:]）', `ask=${modeParsed.mode} work=${modeWork.mode}`);

    // 18. 真实 SSE 样本回归（2026-10-18 实测抓包）
    const sseSample = [
      'event: ready',
      'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
      '',
      'event: update_session',
      'data: {"updated_at":1792295912.796129}',
      '',
      'data: {"v":{"response":{"message_id":2,"role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"测试","references":[]}],"conversation_mode":"DEFAULT"}}}',
      '',
      'data: {"p":"response/fragments/0/content","o":"APPEND","v":"确认"}',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":38},{"p":"quasi_status","v":"FINISHED"}]}',
      'event: close',
    ].join('\n');
    const sse = DeepSeekWebAdapter.parseCompletionSse(sseSample);
    sse.text === '测试确认' && /FINISHED/.test(sse.status)
      ? pass('SSE 解析（真实样本）')
      : fail('SSE 解析（真实样本）', JSON.stringify(sse));

    // 19. 真实流式样本：锚点 -1 + 续写简写 {"v":...}（2026-10-18 第二次抓包）
    const sseStream = [
      'event: ready',
      'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
      '',
      'data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","thinking_enabled":false,"status":"WIP","search_enabled":true,"fragments":[{"id":2,"type":"RESPONSE","content":"⟦","references":[],"stage_id":1}],"conversation_mode":"DEFAULT","auto_continue":false}}}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"TO"}',
      '',
      'data: {"v":"OL"}',
      '',
      'data: {"v":"C"}',
      '',
      'data: {"v":"ALL"}',
      '',
      'data: {"v":"⟧"}',
      '',
      'data: {"v":" ABC"}',
      '',
      'data: {"v":"DEF"}',
      '',
      'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":63},{"p":"quasi_status","v":"FINISHED"}]}',
      '',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      '',
      'event: title',
      'data: {"content":"符号文本输出"}',
      '',
      'event: close',
      'data: {"click_behavior":"none","auto_resume":false}',
      '',
    ].join('\n');
    const sse2 = DeepSeekWebAdapter.parseCompletionSse(sseStream);
    sse2.text === '⟦TOOLCALL⟧ ABCDEF' && /FINISHED/.test(sse2.status)
      ? pass('SSE 解析（-1 锚点+续写简写）')
      : fail('SSE 解析（-1 锚点+续写简写）', JSON.stringify(sse2));

    console.log(process.exitCode ? '\n存在失败用例。' : '\n全部通过。');
    process.exit(process.exitCode ?? 0);
  })();
}

main();
