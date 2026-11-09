# QQ 大肥鱼 1.11 版本（QQ × DeepSeek Harness）一键安装说明

> **1.11 相对上一版新增**：语音情绪（IndexTTS 可选）、用户画像、好感度、作息/犯困、定时提醒、
> 以图生图、语音转文字、群主工具、人格卡 git 版本管理、按量小结、防记忆污染。
> 工具从 70 个压到 **48 个**（每次请求省约 30% 的 schema token）。

> 一套**已经在跑**的 QQ 机器人：她有自己的记忆、心情、零花钱、语音和主动性。
> 这个包把它搬到另一台电脑上跑。
>
> 实测成本：**约 40 条消息/元**（2~3 分钱一条），三天 ¥5.21。详细省钱经验见包外那份文档。

---

## 0. 前置条件（脚本装不了）

| 需要 | 说明 |
|---|---|
| **DeepSeek Harness（DSH）** | 已装好并至少启动过一次（`~/.dsh` 存在） |
| **一个 QQ 小号** | 桥走 OneBot 协议，需要扫码登录 |
| **SnowLuma** | OneBot 网关（github.com/SnowLuma/SnowLuma） |
| **DeepSeek API 账号** | DSH 里已登录或配好 key |
| Windows 10/11 + PowerShell 5.1 | 不需要额外运行时 |

> ⚠️ SnowLuma 安装和 QQ 扫码登录必须手动做一次。

---

## 1. 一键安装

```powershell
cd "D:\QQ鱼省钱经验\QQ一键包"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

会问 4 个问题：

```
1) DSH 配置目录        [默认 C:\Users\<你>\.dsh]
2) 桥要装到哪里        [默认 我的文档\dsh-qq-fish]
3) 你自己的 QQ 号
4) 允许她进的群号      [留空 = 只私聊]
```

然后自动：复制文件 → 写 profile 的 `dependencies` + `bundles` → 生成 `config.json`（含全部默认参数）→ 打印手动三步。

> 无人值守：`install.ps1 -DshHome <路径> -Target <路径> -Qq <QQ号> -Groups "群1,群2"`

---

## 2. 装完要手动做三件事

### ① 启动 SnowLuma
确认 `http://127.0.0.1:3000`（HTTP）和 `ws://127.0.0.1:3001`（WS）可用。

### ② 填 SnowLuma 的 access token
打开 `<安装目录>\config.json`，填 `snowluma.accessToken`。

### ③ 启动桥 + 重启 DSH
```powershell
cd "C:\Users\<你>\Documents\dsh-qq-fish"
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch-detached.ps1
```
看到 `DSH 已就绪（模式: reserved2）` 就成功，然后重启 DSH。

---

## 3. 她有哪些能力

| 能力 | 说明 |
|---|---|
| **长期记忆** | 事件/事实/自我认知/印象四类，跨会话、跨重启；每天自省写一条 |
| **心情** | 0~100，被夸/被凶/被关心会变，会慢慢回落；影响语气和主动程度 |
| **零花钱** | 虚拟账本（不是真钱），能查余额、收钱、花钱 |
| **语音** | 语音库（自己放 mp3）+ 可选克隆合成（CosyVoice2） |
| **表情包/头像** | 豆包生图（需 Edge 登录豆包网页） |
| **视频理解** | 群里的视频会被抽帧理解 |
| **主动行为** | 潜水/主动冒泡/戳一戳/引用回复 |
| **撤回** | 说错话能撤回自己的消息 |
| **精力限额** | 按群设置，说话消耗、随时间恢复 |
| **每日刷 B 站** | 20:00–22:00 随机一次，刷完私信你（默认关） |
| **作息/犯困** | 23:30 后困意上升，半夜只有 @ 和拍一拍能叫醒她 |
| **用户画像** | 她会自己记「你在意什么、喜欢怎样被对待」（`state/profile.json`） |
| **好感度** | 每人独立 0~100，被夸会涨、久不联系会慢慢降 |
| **定时提醒** | 「明天 2 点提醒我」→ 到点她主动私信/戳你 |
| **语音转文字** | 你发的语音条她会转成文字读（需本机装 whisper，默认关） |
| **以图生图** | 引用一张图说「改成水彩风」→ 她画好发回来 |
| **群主工具** | 在她是群主的群里可以禁言/踢人/改名片/发公告/撤回（默认无群） |
| **人格卡 git** | `roles/` 可以 `git init`，改人格可回滚（见 `roles/README.md`） |

---

## 4. 参数在哪调（省钱关键旋钮）

都在 `config.json`：

```jsonc
{
  "dsh": { "reasoningEffort": "high" },   // low / high / max；high 又快又省

  "social": {
    "proactiveCheckMinMs": 1800000,       // 主动冒泡检查间隔 30 分钟
    "proactiveProbability": 0.2
  },

  "socialV2": {
    "wait": { "minQuietAfterNewMs": 5000, "defaultQuietMs": 5000 },
    "wake": { "batchWindowMs": 5000, "preSleepWaitMs": 120000, "recommendedProbability": 0.05 },
    "energy": { "enabled": true, "groups": [ ... ], "cap": 100, "costPerMessage": 1,
                "tiredBelow": 20, "restorePerHour": 30, "maxPerMinute": 5, "maxPerHour": 20,
                "resetOnStart": true },
    "mood": { "enabled": true, "baseline": 65, "sensitivity": "medium" },
    "reflect": { "enabled": true, "hour": 23, "minute": 0, "spreadMin": 40, "minMsgs": 5 },
    "contextGuard": { "enabled": true, "maxTokens": 250000, "minIdleMs": 600000 },
    "voice": { "enabled": true, "maxPerHour": 20, "maxPerMinute": 4, "tts": { "cosyUrl": "http://127.0.0.1:9880" } }
  }
}
```

**三个最省钱的动作**：

1. 降低空转唤醒（概率调低、主动检查间隔拉长）
2. **上下文守门**（已默认开启：超 25 万 token 自动换新会话 —— 这是最有效的省钱开关）
3. 图片/视频压缩抽帧（已内置）

---

## 5. 可选：本地克隆音色（CosyVoice2）

默认**不启用**。想让她用特定音色说任意句子，需要自己部署：

```
1. 独立 venv：pip install torch torchaudio（CPU 版即可，CUDA 快 5~10 倍）
2. git clone https://github.com/FunAudioLLM/CosyVoice
3. 下模型 iic/CosyVoice2-0.5B（约 2GB）
4. 起服务：python cosy_server.py --port 9880
5. config.json → socialV2.voice.tts.cosyUrl 指向它
```

踩过的坑（都在包外文档里）：需要 `wetext`（不用 conda）、torchaudio 2.11 要 torchcodec
或改用 soundfile、CosyVoice 内部要 16k/24k 两种参考音、参考音别带静音。

> 版权提醒：用游戏/影视角色语音做克隆，**仅限自己本地使用**，别分发。

---

## 5.5 可选：语音带情绪（IndexTTS-2.5）

上一版只有 CosyVoice（声音像，但**没有情绪**）。1.11 支持 **IndexTTS-2.5**：

- 0.8B 模型、BF16 推理，6GB 显存能跑（约 3~4GB）
- 支持 8 维情绪向量：happy / angry / sad / afraid / disgusted / melancholic / surprised / calm
- **它和 CosyVoice 抢显存，两个只能开一个**

安装（本机示例，详见 `addons/indextts/`）：

```bash
# 1) 拉代码（GitHub 被墙时用 ghproxy）
git clone --depth 1 --filter=blob:none --sparse https://ghproxy.net/https://github.com/index-tts/index-tts.git
git -C index-tts sparse-checkout set --no-cone '/*' 'indextts/*' 'tools/*'

# 2) 装依赖（需要 Python 3.10/3.11）
pip install uv
uv sync --extra webui --python 3.11 --default-index https://mirrors.aliyun.com/pypi/simple

# 3) 下模型（约 5GB）
python -c "from modelscope import snapshot_download; snapshot_download('IndexTeam/IndexTTS-2.5', local_dir='checkpoints')"
```

然后把 `addons/indextts/indextts_server.py` 放到 index-tts 目录旁边，启动：

```powershell
powershell -File addons/indextts/start-indextts-server.ps1
```

`config.json` 里：

```jsonc
"socialV2": {
  "voice": {
    "tts": {
      "engine": "indextts",          // auto / indextts / cosy
      "indexttsUrl": "http://127.0.0.1:9881",
      "indexttsRef": "C:/.../audio/你的参考音.mp3"   // 必须是**纯说话**片段，别用唱歌
    }
  }
}
```

**调参经验（踩过的坑）**：

- 参考音用唱歌片段 → 音色会漂，必须用说话片段
- 完全无情绪 → 像念稿子；建议默认 `happy`、强度 **0.2**
- 强度 ≥0.4 会破音/电音，「怒」尤其容易
- 轻情绪不要拆句（拆了重起调，断句会怪）

---

## 6. 常用操作

| 想干什么 | 怎么做 |
|---|---|
| 看桥日志 | `bridge.out.log` |
| 重启桥 | `launch-detached.ps1` |
| 改白名单 | `config.json` 的 `allow.groups/private` |
| 换人设 | 改 `roles/*.md`（热加载） |
| 查心情 | `state/mood.json` |
| 换语音 | 换 `audio/` 里的 mp3（同名覆盖即可） |
| DSH 重启后自动重连 | `register-watch-task.ps1`（装个每分钟的守护） |

---

## 7. 已知限制

- **画图**需要 Edge 且**手动登录过豆包网页**（登录态在 `tools/doubao-image/edge-profile`）
- **语音克隆**用 CPU 一句约 20~30 秒；CUDA 快很多
- **QQ 登录**在机房/云服务器 IP 上容易触发风控，建议用家宽
- 本包基于开源 [qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT），LICENSE/NOTICE 已保留

---

## 8. 出问题

| 现象 | 先看 |
|---|---|
| DSH 打不开（Web authentication failed） | 删 `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` 和 `Cookies-journal` |
| 桥连不上 SnowLuma | 查 3000/3001 端口、`snowluma.accessToken` |
| 她不回话 | 看她有没有角色卡、群是否在白名单 |
| 重启 DSH 后她不回 | 端口变了 → 跑 `launch-detached.ps1`（或装 `register-watch-task.ps1` 守护） |
