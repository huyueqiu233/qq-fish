# persona-commit.ps1 — 把人格卡的改动提交进 git（2026-11-07）
#
# 用法：
#   powershell -File scripts/persona-commit.ps1 -Message "人格：不再说『我明白了』——那是客服腔"
#
# 说明：只提交 roles/ 目录；提交完提醒重启桥生效。

param(
    [Parameter(Mandatory = $true)]
    [string]$Message
)

$ErrorActionPreference = 'Stop'
$roles = Join-Path (Split-Path $PSScriptRoot -Parent) 'roles'

if (-not (Test-Path (Join-Path $roles '.git'))) {
    Write-Host "不是 git 仓库：$roles"
    exit 1
}

Push-Location $roles
try {
    $status = git status --porcelain
    if (-not $status) {
        Write-Host '人格卡没有改动'
        exit 0
    }
    git add -A
    git -c user.name='主人' -c user.email='owner@local' commit -m $Message | Out-Host
    $last = git log --oneline -1
    Write-Host ''
    Write-Host "已提交：$last"
    Write-Host '⚠️ 需要重启桥才会生效'
} finally {
    Pop-Location
}
