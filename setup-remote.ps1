$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$configPath = Join-Path $root 'remote-config.local.json'

function New-RandomBase64Url([int]$bytes) {
    $buffer = New-Object byte[] $bytes
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($buffer)
    }
    finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

if (Test-Path $configPath) {
    $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $remoteConfig = [ordered]@{
        endpoint = [string]$existing.endpoint
        topic = [string]$existing.topic
        key = [string]$existing.key
    }
}
else {
    $remoteConfig = [ordered]@{
        endpoint = 'https://ntfy.sh'
        topic = 'muc-' + (New-RandomBase64Url 24)
        key = New-RandomBase64Url 32
    }
    $json = $remoteConfig | ConvertTo-Json
    [IO.File]::WriteAllText($configPath, $json, (New-Object Text.UTF8Encoding($false)))
}

$pairJson = $remoteConfig | ConvertTo-Json -Compress
$pairCode = 'mucgrade-v1:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pairJson)).TrimEnd('=').Replace('+', '-').Replace('/', '_')

Clear-Host
Write-Host '手机提醒配对信息已生成' -ForegroundColor Green
Write-Host '请在安卓 App 中点击“粘贴配对码”，然后点击“开启远程提醒”。' -ForegroundColor Cyan
Write-Host ''
Write-Host $pairCode -ForegroundColor Yellow
Set-Clipboard -Value $pairCode
Write-Host ''
Write-Host '配对码已复制到剪贴板。它相当于密钥，请勿发给他人或提交到 Git。' -ForegroundColor Magenta
Write-Host '配置文件只保存随机频道和加密密钥，不包含成绩或学校账号。'
Read-Host '按回车关闭'
