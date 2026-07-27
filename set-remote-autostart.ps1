param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'MUC手机远程控制.lnk'

if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
    Write-Host '已关闭 MUC 手机远程控制的开机自启。' -ForegroundColor Green
}
else {
    $target = Join-Path $PSScriptRoot '启动手机远程控制.cmd'
    if (-not (Test-Path -LiteralPath $target)) { throw '未找到远程控制启动脚本。' }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Description = 'MUC 手机远程启动网页查分'
    $shortcut.Save()
    Write-Host '已设为登录 Windows 后自动等待手机启动指令。' -ForegroundColor Green
}

Read-Host '按回车关闭'
