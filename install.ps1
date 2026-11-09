# install.ps1 -- QQ x DSH 一键安装（问 4 个问题，剩下的自动做完）
# 也可以无人值守：install.ps1 -DshHome <路径> -Target <路径> -Qq <QQ号> -Groups "群1,群2"
param(
    [string]$DshHome,
    [string]$Target,
    [string]$Qq,
    [string]$Groups
)
# 需要 PowerShell 5.1+；以普通用户身份运行即可（不要用管理员，避免写进错的 profile）。
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Ask([string]$question, [string]$default) {
    if ($default) { Write-Host ("  " + $question + " [" + $default + "]: ") -NoNewline }
    else { Write-Host ("  " + $question + ": ") -NoNewline }
    $answer = Read-Host
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim()
}

Write-Host ''
Write-Host '============================================='
Write-Host '  QQ 大肥鱼 一键安装（qq-bridge + DSH 插件）'
Write-Host '============================================='
Write-Host ''

$dshHome = if ($DshHome) { $DshHome } else { Ask 'DSH 配置目录' (Join-Path $env:USERPROFILE '.dsh') }
$target  = if ($Target)  { $Target }  else { Ask '桥安装目录'     (Join-Path $env:USERPROFILE 'Documents\dsh-qq-fish') }
$qq      = if ($Qq)      { $Qq }      else { Ask '你自己的 QQ 号' '' }
$groups  = if ($Groups)  { $Groups }  else { Ask '允许她进的群号（逗号分隔，可留空）' '' }

if (-not (Test-Path (Join-Path $dshHome 'profiles\desktop'))) {
    Write-Host ''
    Write-Host ('[错误] 没找到 DSH profile: ' + (Join-Path $dshHome 'profiles\desktop')) -ForegroundColor Red
    Write-Host '       请先启动一次 DeepSeek Harness，或手动指定正确的 .dsh 目录。'
    exit 1
}
if ([string]::IsNullOrWhiteSpace($qq)) {
    Write-Host ''
    Write-Host '[错误] QQ 号不能为空（她只会回你，私聊白名单要用到）。' -ForegroundColor Red
    exit 1
}

# ---------- 1. 复制文件 ----------
Write-Host ''
Write-Host '[1/4] 复制文件…'
$srcBridge = Join-Path $PSScriptRoot 'bridge'
if (-not (Test-Path $srcBridge)) { Write-Host ('[错误] 包里缺 bridge 目录: ' + $srcBridge) -ForegroundColor Red; exit 1 }
if (Test-Path $target) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = $target + '.bak-' + $stamp
    Write-Host ('      已有目录，先备份到 ' + $backup)
    Move-Item -LiteralPath $target -Destination $backup
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $srcBridge '*') -Destination $target -Recurse -Force
$toolsSrc = Join-Path $PSScriptRoot 'tools'
if (Test-Path $toolsSrc) { Copy-Item -Path (Join-Path $toolsSrc '*') -Destination $target -Recurse -Force }
Write-Host ('      已装到 ' + $target)

# ---------- 2. 登记到 DSH profile ----------
Write-Host '[2/4] 登记插件到 DSH profile…'
$profileDir = Join-Path $dshHome 'profiles\desktop'
$pkgPath = Join-Path $profileDir 'package.json'
$pkgBak = $pkgPath + '.bak-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $pkgPath -Destination $pkgBak -Force
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-qq-bridge' -NotePropertyValue ('file:' + $target) -Force
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-qq-bridge') { $bundles += 'dsh-qq-bridge' }
$pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
$pkgJson = $pkg | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($pkgPath, $pkgJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('      已写入 ' + $pkgPath + '（备份：' + (Split-Path -Leaf $pkgBak) + '）')

# ---------- 3. 生成 config.json ----------
Write-Host '[3/4] 生成 config.json…'
$cfgPath = Join-Path $target 'config.json'
$example = Join-Path $target 'config.example.json'
$cfg = Get-Content -LiteralPath $example -Raw -Encoding UTF8 | ConvertFrom-Json

$cfg.ownerQQ = [int64]$qq
if (-not $cfg.allow) { $cfg | Add-Member -NotePropertyName allow -NotePropertyValue ([pscustomobject]@{}) -Force }
$cfg.allow | Add-Member -NotePropertyName private -NotePropertyValue @([int64]$qq) -Force
$groupIds = @()
if (-not [string]::IsNullOrWhiteSpace($groups)) {
    foreach ($g in ($groups -split ',')) {
        $t = $g.Trim()
        if ($t -match '^\d{5,12}$') { $groupIds += [int64]$t }
    }
}
$cfg.allow | Add-Member -NotePropertyName groups -NotePropertyValue $groupIds -Force
$cfg.dsh | Add-Member -NotePropertyName reasoningEffort -NotePropertyValue 'high' -Force
$cfg.snowluma | Add-Member -NotePropertyName accessToken -NotePropertyValue '' -Force

# 省钱/节奏默认值（都能在 config.json 里改）
$cfg.social | Add-Member -NotePropertyName proactiveCheckMinMs -NotePropertyValue 1800000 -Force
$cfg.social | Add-Member -NotePropertyName proactiveCheckMaxMs -NotePropertyValue 2700000 -Force
if (-not $cfg.socialV2) { $cfg | Add-Member -NotePropertyName socialV2 -NotePropertyValue ([pscustomobject]@{}) -Force }
$wait = [pscustomobject]@{ minQuietAfterNewMs = 5000; defaultQuietMs = 5000 }
$wake = [pscustomobject]@{ batchWindowMs = 5000; preSleepWaitMs = 120000 }
$cfg.socialV2 | Add-Member -NotePropertyName wait -NotePropertyValue $wait -Force
$cfg.socialV2 | Add-Member -NotePropertyName wake -NotePropertyValue $wake -Force
if ($groupIds.Count -gt 0) {
    $energy = [pscustomobject]@{
        enabled = $true
        groups = $groupIds
        cap = 100
        costPerMessage = 1
        tiredBelow = 20
        restorePerHour = 30
        maxPerMinute = 5
        maxPerHour = 20
        resetOnStart = $true
    }
    $cfg.socialV2 | Add-Member -NotePropertyName energy -NotePropertyValue $energy -Force
}
# 每天随机刷 B 站（默认关闭，想开就把 enabled 改成 true）
$bili = [pscustomobject]@{
    enabled = $false
    key = ('private:' + $qq)
    windowStart = '20:00'
    windowEnd = '22:00'
}
$cfg.socialV2 | Add-Member -NotePropertyName biliDaily -NotePropertyValue $bili -Force


# 1.11 新增：作息 / 好奇心 / 按量小结 / 月度人格复盘 / 语音转写（默认关）
$rest = [pscustomobject]@{ enabled = $true; startHour = 23.5; endHour = 8 }
$cfg.socialV2 | Add-Member -NotePropertyName rest -NotePropertyValue $rest -Force
$curiosity = [pscustomobject]@{ enabled = $true; startHour = 19; endHour = 22 }
$cfg.socialV2 | Add-Member -NotePropertyName curiosity -NotePropertyValue $curiosity -Force
$digest = [pscustomobject]@{ enabled = $true; everyMessages = 50 }
$cfg.socialV2 | Add-Member -NotePropertyName digest -NotePropertyValue $digest -Force
$personaReview = [pscustomobject]@{ enabled = $true; day = 1; hour = 10 }
$cfg.socialV2 | Add-Member -NotePropertyName personaReview -NotePropertyValue $personaReview -Force
# 语音转写：需要本机装 openai-whisper；没装就保持 disabled
$asr = [pscustomobject]@{ enabled = $false; python = ''; script = 'scripts/asr.py'; model = 'base'; timeoutMs = 30000 }
$cfg.socialV2 | Add-Member -NotePropertyName asr -NotePropertyValue $asr -Force

# 心情（桥侧，2026-11-04）：mood 0~100，基线 65，medium = 正常敏感度
$mood = [pscustomobject]@{ enabled = $true; baseline = 65; sensitivity = 'medium' }
$cfg.socialV2 | Add-Member -NotePropertyName mood -NotePropertyValue $mood -Force

# 每天一次"自省"（记忆链 P4）：晚上随机时刻回顾并写长期记忆
$reflect = [pscustomobject]@{ enabled = $true; hour = 23; minute = 0; spreadMin = 40; minMsgs = 5 }
$cfg.socialV2 | Add-Member -NotePropertyName reflect -NotePropertyValue $reflect -Force

# 上下文守门：超过 25 万 token 且空闲 → 自动开新会话（只换 DSH 会话，不删状态）
$guard = [pscustomobject]@{ enabled = $true; maxTokens = 250000; minIdleMs = 600000; includePrivate = $true }
$cfg.socialV2 | Add-Member -NotePropertyName contextGuard -NotePropertyValue $guard -Force

# 语音：默认开启"语音库"，克隆合成需要自己部署 CosyVoice（可选）
$voiceTts = [pscustomobject]@{ engine = 'auto'; cosyUrl = 'http://127.0.0.1:9880'; indexttsUrl = 'http://127.0.0.1:9881'; indexttsRef = ''; voice = 'zh-CN-XiaoyiNeural' }
$voice = [pscustomobject]@{ enabled = $true; maxPerHour = 40; maxPerMinute = 6; tts = $voiceTts }
$cfg.socialV2 | Add-Member -NotePropertyName voice -NotePropertyValue $voice -Force
if (-not $cfg.socialV2.tools) { $cfg.socialV2 | Add-Member -NotePropertyName tools -NotePropertyValue ([pscustomobject]@{}) -Force }
$cfg.socialV2.tools | Add-Member -NotePropertyName sendVoice -NotePropertyValue $true -Force

$cfgJson = $cfg | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($cfgPath, $cfgJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('      已生成 ' + $cfgPath)

# ---------- 4. 提示后续手动步骤 ----------
Write-Host '[4/4] 完成。' -ForegroundColor Green
Write-Host ''
Write-Host '接下来还要手动做三件事（脚本做不了）：'
Write-Host ''
Write-Host '  ① 启动 SnowLuma（OneBot 网关），扫码登录你的 QQ 小号'
Write-Host '     确认 http://127.0.0.1:3000 和 ws://127.0.0.1:3001 可用'
Write-Host ''
Write-Host ('  ② 把 SnowLuma 的 access token 填进 ' + $cfgPath)
Write-Host '     路径：snowluma.accessToken'
Write-Host ''
Write-Host '  ③ 启动桥，然后重启 DSH：'
Write-Host ('     cd "' + $target + '"')
Write-Host '     powershell -NoProfile -ExecutionPolicy Bypass -File .\launch-detached.ps1'
Write-Host ''
Write-Host '  看到 "SnowLuma 已连接" + "DSH 已就绪（模式: reserved2）" 就成功了。'
Write-Host ''
Write-Host '  想画表情包/头像的话，还要用 Edge 打开 https://www.doubao.com 手动登录一次。'
Write-Host ''
