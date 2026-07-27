$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$studioJbr = $null
$shortcut = Get-ChildItem `
    'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Android Studio', `
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Android Studio" `
    -Filter '*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($shortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
    if ($target) { $studioJbr = Join-Path (Split-Path (Split-Path $target -Parent) -Parent) 'jbr' }
}
$javaCandidates = @(
    $env:JAVA_HOME,
    $studioJbr,
    'C:\Program Files\Android\Android Studio\jbr'
) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'bin\java.exe')) }

if (-not (Test-Path $sdk)) { throw '未找到 Android SDK，请设置 ANDROID_HOME。' }
if (-not $javaCandidates) { throw '未找到 JDK 17+，请设置 JAVA_HOME。' }

$env:JAVA_HOME = $javaCandidates[0]
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

$aapt2 = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'aapt2.exe' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
$gradleArguments = @('--no-daemon')
if ($aapt2) { $gradleArguments += '-Pandroid.aapt2FromMavenOverride=' + $aapt2 }
$gradleArguments += ':app:assembleRelease'

Push-Location $projectRoot
try {
    & (Join-Path $projectRoot 'gradlew.bat') $gradleArguments
    $gradleExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
if ($gradleExitCode -ne 0) { throw 'APK 构建失败。' }

$signingDirectory = Join-Path $projectRoot '.signing'
$keystore = Join-Path $signingDirectory 'muc-grade-helper-release.p12'
$passwordFile = Join-Path $signingDirectory 'password.txt'
if (-not (Test-Path $signingDirectory)) { New-Item -ItemType Directory -Path $signingDirectory | Out-Null }
if (-not (Test-Path $passwordFile)) {
    $buffer = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    $password = [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [IO.File]::WriteAllText($passwordFile, $password, (New-Object Text.UTF8Encoding($false)))
}
$password = [IO.File]::ReadAllText($passwordFile, [Text.Encoding]::UTF8).Trim()
if (-not (Test-Path $keystore)) {
    & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -noprompt `
        -keystore $keystore -storetype PKCS12 -storepass $password -keypass $password `
        -alias muc-grade-helper -keyalg RSA -keysize 3072 -validity 10000 `
        -dname 'CN=MUC Grade Helper, O=Personal Open Source'
    if ($LASTEXITCODE -ne 0) { throw 'APK 签名密钥生成失败。' }
}

$buildTools = Split-Path $aapt2 -Parent
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$unsigned = Join-Path $projectRoot 'app\build\outputs\apk\release\app-release-unsigned.apk'
$aligned = Join-Path $projectRoot 'app\build\outputs\apk\release\app-release-aligned.apk'
$target = Join-Path (Split-Path $projectRoot -Parent) 'MUC成绩远程提醒.apk'
& $zipalign -f 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'APK 对齐失败。' }
& $apksigner sign --ks $keystore --ks-key-alias muc-grade-helper `
    --ks-pass ('pass:' + $password) --key-pass ('pass:' + $password) `
    --out $target $aligned
if ($LASTEXITCODE -ne 0) { throw 'APK 签名失败。' }
& $apksigner verify --verbose $target
if ($LASTEXITCODE -ne 0) { throw 'APK 签名验证失败。' }
Write-Host ("APK 已生成：" + $target) -ForegroundColor Green
