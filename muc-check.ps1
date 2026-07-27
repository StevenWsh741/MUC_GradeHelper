[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot

function Get-UiText([string]$Base64) {
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Base64))
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host (Get-UiText "ICAgICAgTVVDIOacrOWtpuacn+aIkOe7qeiHquWKqOajgOafpeWKqeaJiw==") -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host (Get-UiText "5a+G56CB5Y+q5Zyo5pys5qyh6L+Q6KGM55qE5YaF5a2Y5Lit5L2/55So77yM5LiN5Lya5YaZ5YWl5paH5Lu244CC") -ForegroundColor Yellow
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host (Get-UiText "5pyq5om+5YiwIE5vZGUuanPjgILor7flhYjlronoo4UgTm9kZS5qcyBMVFPvvJpodHRwczovL25vZGVqcy5vcmcv") -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules\playwright-core"))) {
    Write-Host (Get-UiText "6aaW5qyh6L+Q6KGM77yM5q2j5Zyo5a6J6KOF5rWP6KeI5Zmo5o6n5Yi257uE5Lu24oCm4oCm") -ForegroundColor Yellow
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Host (Get-UiText "5L6d6LWW5a6J6KOF5aSx6LSl77yM6K+35qOA5p+l572R57uc5ZCO6YeN6K+V44CC") -ForegroundColor Red
        exit 1
    }
}

$username = Read-Host (Get-UiText "6K+36L6T5YWl5a2m5Y+3L+e7n+S4gOi6q+S7veiupOivgeeUqOaIt+WQjQ==")
if ([string]::IsNullOrWhiteSpace($username)) {
    Write-Host (Get-UiText "55So5oi35ZCN5LiN6IO95Li656m644CC") -ForegroundColor Red
    exit 1
}

$securePassword = Read-Host (Get-UiText "6K+36L6T5YWl57uf5LiA6Lqr5Lu96K6k6K+B5a+G56CB77yI6L6T5YWl5YaF5a655LiN5Y+v6KeB77yJ") -AsSecureString
$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
    $env:MUC_USERNAME = $username.Trim()
    $env:MUC_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
    & node.exe (Join-Path $PSScriptRoot "muc-score-checker.js") --loop
}
finally {
    $env:MUC_USERNAME = $null
    $env:MUC_PASSWORD = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
    $securePassword.Dispose()
}
