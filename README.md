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

### 1. 精确判定矩阵与具体阈值（核心数据一览）

插件按**会话类型（主会话 vs 隔离子代理）**、**文件类型**与**体积阈值**执行以下确定性策略：

| 场景 / 媒体类型 | 条件与数据阈值 | Hook 决策 | 具体处理方式与输出 |
| :--- | :--- | :--- | :--- |
| **非媒体文件 / 不存在路径** | `.ts/.py/.json/.md/.pdf` 等或缺失文件 | `allow`（放行） | 直接放行，0 阻塞；异常/解析失败也 fail-open 放行。 |
| **视频 / 音频（主会话）** | 任意体积（`> 0 B`） | `deny`（拦截） | **禁止直接挂入主会话历史**。提示 Agent 按文件大小走下述分支。 |
| **视频 / 音频（隔离子代理）** | **单文件 `≤ 15 MB`** 且 **子代理累计 `≤ 20 MB`** | `allow`（放行） | 子代理用 `read_file` 看原画质、原帧率原片，只把纯文本总结回传主会话。 |
| **视频 / 音频（隔离子代理）** | **单文件 `> 15 MB`** 或 **子代理累计 `> 20 MB`** | `deny`（拦截） | 阻止原片直读；强制先用 `prep_media.mjs` 预处理（或每个文件单开子代理 / 走 `gemini-api`）。 |
| **图片（主会话 / 子代理）** | **单张 `≤ 15 MB`** 且 **当前会话累计 `≤ 25 MB`** | `allow`（放行） | 常规截图静默放行，不打扰日常 UI 调试。 |
| **图片（主会话 / 子代理）** | **单张 `> 15 MB`** 或 **当前会话累计 `> 25 MB`** | `ask`（弹窗确认） | 提示已占用的 `logs/media/` 累计体积，由你决定放行或改走缩放/子代理。 |

---

### 2. 具体操作方式：小于等于 15 MB vs 大于 15 MB 怎么处理？

#### 情况 A：视频 / 音频 `≤ 15 MB`（如几秒～数分钟录屏、常规短视频）

1. 你直接把路径发给 Antigravity（例如：“帮我分析 `C:\Videos\bug.mp4` 里第 10 秒动画为什么卡顿”）。
2. 如果主会话尝试直接 `read_file`，`PreToolUse` Hook 会拦截并提示改用子代理隔离。
3. Agent 自动调用 `invoke_subagent`（一次性子代理）执行 `read_file`：
   * 子代理看到的是**未经压缩、原帧率（30/60fps）、带完整音轨**的原片；
   * Hook 校验 `文件 ≤ 15 MB` 且 `累计 ≤ 20 MB` 后自动 `allow`；
   * 子代理把分析结果以**纯文本**返回主会话，主会话 `logs/media/` 保持 `0 MB` 增量。
4. **注意**：若同一轮需要对比 2 个视频（例如 `12 MB + 12 MB = 24 MB > 20 MB`），应分别派两个子代理各看一个，再由主会话汇总对比。

#### 情况 B：视频 `> 15 MB`（大视频 / 长视频），有 4 种具体处理路径

根据你想看“整体内容”“语音内容”还是“精细动态运动”，选择对应模式：

1. **总览长视频结构 → 关键帧缩略图网格（`--mode keyframes`）**
   * **操作命令**：
     ```bash
     node ~/.gemini/config/plugins/media-guard/scripts/prep_media.mjs --input "demo.mp4" --mode keyframes --cols 4 --rows 3
     ```
   * **具体参数与输出**：默认抽取 `4×3 = 12` 帧（可用 `--cols` / `--rows` / `--interval <秒>` 调整），单格宽 `480px`（`scale=480:-1`），带时间戳水印，输出 `*_keyframes.jpg`（实测 191 秒 `7.6 MB` 视频输出仅 **`0.26 MB`**）。主会话或子代理可直接用 `read_file` 看这张拼图。

2. **看长视频里的物体动态运动 / 掉帧细节 → 先定位再局部高清裁剪（`--mode clip`，最推荐）**
   * **为什么不直接压缩整片**：整片硬压会降帧率、降清晰度，丢失高速运动细节。
   * **两步操作**：
     1. 先用上面的 `--mode keyframes` 定位动作发生的时间段（例如 `00:01:20` 左右）；
     2. 再用 `--mode clip` 截取目标窗口（默认 `15` 秒）：
        ```bash
        node ~/.gemini/config/plugins/media-guard/scripts/prep_media.mjs --input "demo.mp4" --mode clip --start 00:01:20 --duration 15
        ```
   * **具体参数与输出**：使用 `libx264 -preset fast -crf 22` + `aac 96k`，**保留原片原始分辨率与原始帧率**。十几秒的高清片段通常只有几 MB（`≤ 15 MB`），直接交给一次性子代理看原画运动即可。

3. **只听口播 / 会议 / 语音内容 → 提取单声道轻量音频（`--mode audio`）**
   * **操作命令**：
     ```bash
     node ~/.gemini/config/plugins/media-guard/scripts/prep_media.mjs --input "meeting.mp4" --mode audio
     ```
   * **具体参数与输出**：转出 `16000 Hz` 单声道 `32 kbps` MP3（约 **`240 KB / 分钟`**，约 60 分钟语音也仅 `~14 MB ≤ 15 MB`），交给一次性子代理读取。

4. **需要看全片连贯画面 → 自动压制到 15 MB 以内（`--mode compress`）**
   * **操作命令**：
     ```bash
     node ~/.gemini/config/plugins/media-guard/scripts/prep_media.mjs --input "demo.mp4" --mode compress --max-mb 12
     ```
   * **具体参数与输出**：限制最大宽度 `854px`、帧率 `15 fps`、音频单声道 `48 kbps` AAC，并按视频时长反推视频码率（限定在 `80 ~ 800 kbps` 之间）压出 `*_compact.mp4`（默认目标 `≤ 12 MB`，留足安全余量），再交给一次性子代理观看。
   * **注意**：超过 ~15 分钟的长视频硬压进 `12 MB` 时码率会贴近下限 `80 kbps` 导致画质明显变糊，此时应改用方案 2（`clip` 分段）或配合 `GEMINI_API_KEY` 走 `gemini-api files upload`（上限 `2 GB`，服务端缓存 `48 小时`）。

*(提示：也可先执行 `node .../prep_media.mjs --input "demo.mp4" --mode info` 查看视频精确时长、体积 MB、分辨率与音视频编码再决定模式。)*

---

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
