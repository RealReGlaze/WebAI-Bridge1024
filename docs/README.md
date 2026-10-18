# WebAI Bridge — 多网页 AI 通用桥接器 + 本地 Harness

Windows 本地系统：用您已正常登录的网页 AI（DeepSeek / 千问等）作为 Agent Runtime 的推理后端，搭配本地工具执行闭环。

## 安装（Windows）

1. 要求：Node.js ≥ 20（本机 v24.16.0 已验证）、Edge 浏览器（Windows 自带）。
2. 本项目所有依赖均为**项目局部安装**，不装全局包：
   ```powershell
   cd E:\All\创作类项目-Temp\WebAPI
   npm.cmd install      # 注意：本机 npm.ps1 被执行策略禁用，统一用 npm.cmd
   ```
3. 无需下载 Playwright 浏览器包（仅 `playwright-core`，驱动已有的 Edge）。

## 使用

**交互模式（推荐，任意目录可用）**：项目自带 `bin/webai.cmd`，无参启动进入 Claude 式交互界面：

```powershell
webai.cmd                        # 横幅显示版本/工作目录（=你打开命令行时所在的目录），>> 输入任务目标
webai.cmd --yes -t 20            # 高风险自动放行；轮数预算 20
```

- 每次在 `>>` 后输入任务目标回车即执行一个任务，可连续多轮交互。
- **默认工作区 = 你打开命令行时所在的目录**（`-C` 可临时切换；相对路径也基于它解析）。启动器会跨目录捕获原始目录，与项目根无关。
- **工作模式由模型自判定**：模型在首轮回复声明 `<mode>ask</mode>`（快问快答，轮数预算自动收缩为 3 轮）或 `<mode>work</mode>`（正式执行任务，按启动预算走）。
- 内置命令：`/tasks` 任务列表 · `/show <ID>` 任务详情 · `/exit` 退出。
- 键盘输入中文正常；若脚本管道喂入中文请先把宿主 pipe 编码设为 UTF-8（PowerShell 5.1 默认对原生程序管道用 ASCII，会把中文变 `?`）：
  ```powershell
  $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
  "任务目标" | webai.cmd --yes
  ```

**一键（CI 式）用法**：

```powershell
E:\...\WebAPI\bin\webai.cmd ci "修复所有失败的测试"                 # -t 20 --yes 可选
E:\...\WebAPI\bin\webai.cmd ci "实现XX功能" -C E:\proj\myapp       # 指定工作区
E:\...\WebAPI\bin\webai.cmd ci --continue                          # 恢复同工作区最近未完成任务
E:\...\WebAPI\bin\webai.cmd ci --resume tmvdbnhod                  # 恢复指定任务（webai start -- list 查看 ID）
```

`ci` 详细参数：`-t/--max-turns N` 本轮最大轮数（默认 15）；`--yes` 高风险操作自动放行（不带则逐项 y/n 人工确认）；`--debug` 输出回复等待诊断。

无需启动器时也可从项目根运行（Windows npm 需用 npm.cmd）：

```powershell
cd E:\All\创作类项目-Temp\WebAPI
npm.cmd install      # 注意：本机 npm.ps1 被执行策略禁用，统一用 npm.cmd
npm.cmd start -- ci "任务" -C E:\proj\myapp --yes     # 与 bin/webai.cmd 等价
npm.cmd start -- chat "写一个 helloworld.ts"          # 单轮对话
npm.cmd start -- browser / status / probe / list      # 连接、状态、页面诊断、任务列表
npx.cmd tsx scripts/smoke.ts                          # 本地冒烟测试（21 项，不依赖网页）
```

- 首次运行会弹出一个**专用 Edge 窗口**（独立 profile：`.runtime/edge-profile-deepseek`），请在其中手动登录一次；登录态由浏览器本体保存，本系统**不读取、不存储任何 Cookie/密码/令牌**。
- 模型后端在 `config/backends.json` 中增删；新增网页 AI 只需实现一个新的 `IModelAdapter` 子类并在 `src/adapters/factory.ts` 注册。

## 阶段进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 环境/Harness 调查 | ✅ 完成（目录为空，全新实现；Node24/Edge/Git 确认） |
| 2 | Adapter 接口 + 通用浏览器原型 | ✅ 完成（CDD 附加 + Edge 专用实例） |
| 3 | DeepSeek 适配器 | ✅ 完成（2026-10-18 实机全测通过：登录检测/收发/多轮记忆/会话id提取/新建会话） |
| 4 | 千问适配器 | 未开始（待用户配合登录 qianwen.com 一次性验证） |
| 5 | 工具执行闭环 | ✅ 完成（2026-10-18 单次运行端到端通关：创建→测试失败→apply_patch 自修复→重测→ALL PASSED；CDP SSE 网络通道为主检测源） |
| 6 | 模型切换/状态管理 | 🔶 部分完成（`ci --resume/--continue` 断点续跑已实现并实测；跨模型切换待做） |
| 7 | 界面/打包/完整文档 | 未开始 |

## 已知限制

- 网页 AI 的服务条款可能禁止自动化使用；每个适配器可用性都需实测，不保证长期可用。
- 回复完成判定：网络通道为**确定性**判定（服务端 FINISHED 签名）；仅当网络通道不可用、退回 DOM 通道时才用"文本连续稳定"启发式（超长或分段渲染可能误判）。
- 页面改版会导致选择器失效；用 `probe` 诊断后在 `config/backends.json` 的 `selectors` 覆盖即可，无需改代码。
- DeepSeek 页面元素类名是哈希混淆的（如 `_5a8ac7a`），选择器只能基于 id/placeholder/文本定位。
- 任务内**禁止嵌套调用 webai 自身**（协议禁令 + `WEBAI_AGENT_SESSION` 环境守卫，run_command 派生的孙进程同样被拦）。查看某任务完整成果用 `webai start -- show <ID> [--transcript]`。
- `-t/--max-turns` 上限被钳制为 1~50，防止模型自行传入超大轮数。
- tsx/esbuild 环境下 `page.evaluate` 传函数会被注入 `__name` 导致浏览器端 ReferenceError，需以字符串形式传 JS（适配器已遵循此模式）。
- DeepSeek 的代码块会用"复制/下载"按钮渲染，`innerText` 提取会吞掉 ``` 围栏——因此协议使用 ⟦TOOLCALL⟧/⟦ARG…⟧ 这类不被 markdown 渲染器转换的 unicode 标记（U+27E6/27E7）。
- 回复检测分两级：**首选网络通道**——CDP 旁听页面自身发出的 `POST /api/v0/chat/completion` SSE（PoW 挑战由页面原生计算，我们不构造/签名/重放任何请求，只是读取自己会话的响应），文本来自数据流、无渲染损伤，`response/status: FINISHED` 是确定性完成信号；**备用 DOM 通道**——消息计数（`ds-markdown` 数）+ 聊天区重组感知差分（前缀/包含/尾尾公共后缀三级）。
- DeepSeek completion SSE 真实格式（2026-10-18 两次抓包实证，解析器已按此实现并有回归样本）：① 开头快照 `{"v":{"response":{"fragments":[{"type":"RESPONSE","content":"⟦前缀"}]}}}` 的 content 只是**当时已流出的前缀**；② 之后块为锚点式 `{"p":"response/fragments/-1/content","o":"APPEND","v":"X"}`（-1=当前活动 fragment）；③ 再之后的续写是**纯简写** `data: {"v":"X"}`，无 p/o，隐式沿用上一次 /content 路径；④ `quasi_status` 是 token 级状态（流早期就=FINISHED），**不能**当完成信号，只有 `{"p":"response/status","o":"SET","v":"FINISHED"}` 算数；⑤ 会话标题走同一 SSE 里的 `event: title`（独立短文本，勿混入正文）；⑥ `getResponseBody` 在流未结束时返回已缓冲前缀，因此只有出现 FINISHED 签名才落盘响应（dataReceived 500ms 节流滚动尝试）。
- DeepSeek 会折叠重组历史消息，DOM 全文差分可能失效；网络通道不受此影响。单条响应 body 丢失时 DOM 通道有 90s 宽限窗口。
- 专用 Edge 由启动 webai 的进程派生：在普通终端里它独立存活（任务结束后窗口留着可继续用）；但在某些进程作业管控环境（IDE 集成终端/CI runner/代理 harness）里，宿主结束后 Edge 可能被一并回收，再次运行 webai 会自动重启（幂等复用逻辑已实现）。
- 「内容为 raw 参数」的协议设计：代码/补丁类参数写在 ⟦ARG x⟧…⟦/ARG⟧ 之间，避免 JSON 转义（实测模型在自由对话中无法稳定完成 `\"` 转义，DSML 原生模板也得靠归一化兜底）。
