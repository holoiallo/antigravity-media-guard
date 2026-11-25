# Antigravity Media Guard (`media-guard`)

防止 Antigravity 在主力会话中直接读取音视频原文件，导致每轮对话与工具调用往返反复全量重传原始媒体字节、跑满上行带宽并把 Session 卡死的防爆守卫插件。

插件零第三方 npm 依赖，仅使用 Node.js 内置模块与可选的本机 `ffmpeg` / `ffprobe`。

---

## 核心特性

1. **`PreToolUse` 钩子守门（`read_file` / `view_file`）**
   * **非媒体文件零干扰**：所有代码、Markdown、JSON、PDF 等文本/文档文件以及不存在的路径，直接 `allow` 放行；解析或 I/O 异常时自动 fail-open，绝不阻断正常开发工作流。
   * **主会话禁读原始音视频**：拦截主会话对 `.mp4`、`.mov`、`.mkv`、`.avi`、`.webm`、`.wav`、`.mp3`、`.m4a` 等文件直接调用 `read_file`，引导 Agent 改为「一次性子代理隔离读取」或「本地 `ffmpeg` 预处理」。
   * **子代理白名单放行（保留原生多模态理解）**：自动识别由 `invoke_subagent` 启动的隔离子代理，当单文件 `≤ 15 MB` 且子代理媒体累计 `≤ 20 MB` 时放行原片直读，既不损失帧率与动态理解能力，又保证主会话零污染。
   * **图片累计体积熔断**：普通截图静默放行；当单张图片 `> 15 MB` 或当前会话 `logs/media/` 累计媒体超过 `25 MB` 时触发 `ask` 弹窗确认，防止几十张大图叠加拖慢会话。
2. **本地 `ffmpeg` 预处理工具（`scripts/prep_media.mjs`）**
   * `--mode info`：通过 `ffprobe` 探测时长、分辨率、编码与大小。
   * `--mode keyframes`：生成带时间戳网格的关键帧缩略图（`.jpg`），快速总览长视频结构。
   * `--mode audio`：提取单声道低码率语音（`16kHz / 32kbps .mp3`，约 `240 KB/min`）。
   * `--mode clip`：按 `--start` 与 `--duration` 精准截取局部片段（保留原高帧率，专门解决长视频里“物体动态运动细节”的分析需求）。
   * `--mode compress`：将超限视频压制为 `≤ 12 MB` 的紧凑 MP4，供子代理直接观看。
3. **全局规范与技能引导（`AGENTS.md` + `media-safe-read`）**
   * 指导 Agent 自动按文件大小选择「子代理原片直读」「局部切片」或「`gemini-api` Files API」路径，并提示切勿在已卡死的旧会话中硬跑 `/compact`。

---

## 兼容性说明

| 检查维度 | 支持情况 | 说明 |
| :--- | :--- | :--- |
| **操作系统** | Windows 10/11、macOS、Linux | Hook 脚本与预处理脚本统一采用 Node.js 跨平台路径与数组参数调用 `execFileSync`，支持空格及中文路径；适配 Windows `cmd /c` 与 Unix `sh -c` 管道标准输入（异步流读取 `stdin`）。 |
| **Antigravity 形态** | Antigravity 2.0 Desktop / IDE / CLI | 同时匹配 `read_file`（`args.Path`）与 `view_file`（`args.AbsolutePath`）；通过 Hook 动态传入的 `transcriptPath` 自动定位 `.gemini/antigravity*/*/logs/media/`，不硬编码产品目录。 |
| **会话类型** | 主会话、Subagents、Swarm | 主会话严格防护；一次性 Subagent（`step_index: 0` 为 `SYSTEM_MESSAGE`）享受 `≤ 15 MB` 原片放行；长生命周期 Swarm Worker 同样受保护。 |
| **Node.js 版本** | `>= 18.0.0` | 零第三方依赖，仅依赖标准库 `node:fs`、`node:path`、`node:child_process`。需确保 `node` 在系统 `PATH` 中。 |
| **FFmpeg 依赖** | 可选（强烈建议安装） | **缺失 `ffmpeg` 不影响 Hook 拦截与子代理隔离功能**；仅在使用 `prep_media.mjs` 抽帧、裁剪、提取音频或压缩大视频时需要本机安装 `ffmpeg` / `ffprobe`。 |
| **其他插件共存** | 完全兼容 | 仅监听 `PreToolUse` 的 `read_file\|view_file`，与 `think-translate`、`agy-powertools`、`agy-sidebar-plus`、`colab`、`hyperrender` 等插件无冲突。 |

---

## 安装方法

将本仓库克隆到 Antigravity 全局插件目录 `~/.gemini/config/plugins/media-guard`：

### Windows (PowerShell)

```powershell
git clone https://github.com/holoiallo/antigravity-media-guard.git "$env:USERPROFILE\.gemini\config\plugins\media-guard"
```

### macOS / Linux

```bash
git clone https://github.com/holoiallo/antigravity-media-guard.git ~/.gemini/config/plugins/media-guard
```

### 安装 FFmpeg（可选，用于大视频预处理）

* **Windows**：`winget install Gyan.FFmpeg`
* **macOS**：`brew install ffmpeg`
* **Ubuntu / Debian**：`sudo apt install ffmpeg`

### 启用插件

在 Antigravity 的 **Customizations / Plugins** 页面找到 **Media Guard** 并开启即可（实时生效，无需重启；随时可一键关闭）。

---

## 使用指南

### 1. 日常使用（全自动无感触发）

安装并启用后无需手动敲命令，直接把本地视频/音频路径发给 Agent 即可：
* **中小视频（`≤ 15 MB`）**：若主会话尝试直读，Hook 会自动拦截并引导 Agent 派一个一次性子代理观看原片后返回文字总结，**主会话完全不挂载任何视频二进制**。
* **超大视频（`> 15 MB`）**：Agent 会自动调用 `media-safe-read` 技能和 `prep_media.mjs` 先做抽帧/提音轨/切片，再进行针对性分析。

### 2. 长视频精细动作 / 物体动态运动怎么看？

抽帧拼图（`keyframes`）会丢失连续帧率，如果要在几十 MB 的长视频里分析物体运动、UI 掉帧或动作细节，建议让 Agent 按两步走（或直接这样提示）：

1. 先用关键帧定位动作发生的时间窗口：
   ```bash
   node ~/.gemini/config/plugins/media-guard/scripts/prep_media.mjs --input "demo.mp4" --mode keyframes --cols 4 --rows 3
   ```
2. 再用 `--mode clip` 把目标十几秒的高帧率片段单独切出来，交给一次性子代理看原画动态：
   ```bash
   node ~/.gemini/config/plugins/media-guard/scripts/prep_media.mjs --input "demo.mp4" --mode clip --start 00:01:20 --duration 15
   ```

### 3. 如果某个旧会话已经被媒体卡爆了怎么办？

* **不要在卡死的会话里直接跑 `/compact`**：压缩请求依然会打包历史步骤里的媒体数据，照样卡住。
* **推荐做法**：使用 Antigravity 原生菜单的 **「分支会话」** 回溯到读取视频之前的那一轮对话，或者直接开一个新会话并粘贴已有文字结论。

### 4. 可选环境变量配置

可通过系统环境变量调整默认阈值：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `MEDIA_GUARD_SUBAGENT_MAX_MB` | `15` | 子代理单次允许直接读取的音视频体积上限（MB） |
| `MEDIA_GUARD_SUBAGENT_BUDGET_MB` | `20` | 子代理会话内允许挂载的媒体累计体积上限（MB） |
| `MEDIA_GUARD_SINGLE_IMAGE_ASK_MB` | `15` | 单张图片触发 `ask` 确认的体积阈值（MB） |
| `MEDIA_GUARD_MEDIA_BUDGET_MB` | `25` | 会话累计媒体触发图片 `ask` 确认的阈值（MB） |
| `MEDIA_GUARD_DISABLE` | `0` | 设为 `1` 时临时放行所有读取（紧急旁路开关） |

---

## 本地测试

仓库内置了自包含测试套件（自动校验 Hook 决策与 `prep_media.mjs` 全部 5 种模式）：

```bash
node tests/test_guard.mjs
```

---

## 目录结构

```text
antigravity-media-guard/
├── plugin.json                      # 插件元数据 (v1.1.0)
├── hooks.json                       # PreToolUse (read_file|view_file) Hook 配置
├── assets/
│   └── logo.svg                     # 插件图标
├── rules/
│   └── AGENTS.md                    # 防卡死会话规范
├── scripts/
│   ├── read_file_guard.mjs          # PreToolUse 守卫脚本（零外部依赖）
│   └── prep_media.mjs               # FFmpeg / FFprobe 预处理助手
├── skills/
│   └── media-safe-read/
│       └── SKILL.md                 # 安全读取音视频技能指南
└── tests/
    └── test_guard.mjs               # 跨平台单元测试与合成视频集成测试
```

## 开源协议

[MIT License](./LICENSE)
