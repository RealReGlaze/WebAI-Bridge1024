# WebAI Bridge 安装指南 / Install Guide

发布形式是一个 `.zip` 压缩包（但是我懒得做了）。解压后运行对应平台的 setup 脚本即可完成全部安装。

## 安装步骤

### Windows
1. 下载 `webai-bridge-<版本>.zip`，**右键 → 全部解压**（不要在压缩包内直接运行）。
2. 双击 **`setup.bat`**。
3. 脚本会自动完成：
   - 检查 Node.js ≥ 20（缺失时尝试用 winget 自动安装）；
   - `npm install`（依赖全部装在项目内，不污染全局；已规避 `npm.ps1` 执行策略问题）；
   - 把安装目录的 `bin` 加入**用户 PATH**、写入 `WEBAI_HOME`（仅写 HKCU，无需管理员权限）；
   - 检测 Edge、验证运行时。
4. **打开一个新的终端窗口**，输入 `webai` 即可（任意目录可用）。

### macOS / Linux
1. 解压 zip（macOS 可直接双击解压；Linux 用 `unzip webai-bridge-*.zip`）。
2. 在解压出的目录里运行：
   ```bash
   bash setup.sh
   ```
   （zip 解压不保留可执行位，所以用 `bash` 前缀启动，不要直接 `./setup.sh`。）
3. 脚本会自动完成：Node.js ≥ 20 检查（缺失时询问后经 Homebrew / NodeSource / dnf / pacman 安装）→ `npm install` → 把 `bin/webai` 软链到 `~/.local/bin/webai` 并写入 shell 配置（zsh/bash 的 PATH 与 `WEBAI_HOME`，带 `# >>> webai-bridge >>>` 标记块，可重复执行）→ 浏览器检测与运行时验证。
4. 重开终端（或 `source ~/.zshrc` / `source ~/.bashrc`），输入 `webai` 即可。

## 浏览器要求

WebAI Bridge 通过 CDP 驱动本机浏览器，登录态由浏览器 profile（项目内 `.runtime/`）保存，本系统**不读取、不存储任何 Cookie/密码/令牌**。

- Windows：系统自带 Edge，开箱即用。
- macOS / Linux：推荐安装 [Microsoft Edge](https://www.microsoft.com/edge/download)；未装 Edge 时会自动回退到 Chrome/Chromium（同引擎，CDP 协议一致）。也可在 `config/backends.json` 中为每个后端指定 `browser.executablePath`。

## 使用速查

```bash
webai                     # 交互模式（在 >> 后输入任务目标）
webai ci "修复所有失败的测试"    # 一键式单任务
webai ci "任务" -C /path/to/proj --yes   # 指定工作区 + 自动放行
```

首次运行会弹出专用浏览器窗口，请手动登录一次网页 AI（DeepSeek / MiMo 等）。

## 卸载

- Windows：运行 `uninstall.bat`（移除 PATH 与 `WEBAI_HOME`，不删文件）。
- macOS / Linux：`bash uninstall.sh`（移除软链与 shell 配置块，不删文件）。
- 之后可手动删除安装目录；`.runtime/` 里的浏览器 profile 不含凭据，删除只是退出网页登录态。

## 维护者：打发布包

在项目根执行（会排除 `node_modules/`、`.runtime/`、`.git/`、`dist/`）：

```powershell
# Windows
powershell -File scripts\pack-zip.ps1
```
```bash
# macOS / Linux
bash scripts/pack-zip.sh
```

产物：`dist/webai-bridge-<版本>.zip`。用户解压后即看到根目录的 `setup.bat` / `setup.sh`。
