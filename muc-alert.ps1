param(
    [Parameter(Mandatory = $true)][string]$TitleBase64,
    [Parameter(Mandatory = $true)][string]$DetailsBase64,
    [Parameter(Mandatory = $true)][string]$SpeechBase64,
    [Parameter(Mandatory = $true)][string]$VideoPathBase64,
    [int]$RepeatCount = 2,
    [int]$SpeechRate = 3,
    [int]$AutoCloseSeconds = 0,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$errorLogPath = Join-Path $PSScriptRoot '.alert-error.log'
$statusLogPath = Join-Path $PSScriptRoot '.alert-status.log'

trap {
    $errorText = "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))]`r`n$($_ | Out-String)"
    [System.IO.File]::WriteAllText($errorLogPath, $errorText, [System.Text.Encoding]::UTF8)
    exit 1
}

function Decode-Text([string]$Value) {
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName System.Speech

if (Test-Path -LiteralPath $errorLogPath) {
    Remove-Item -LiteralPath $errorLogPath -Force -ErrorAction SilentlyContinue
}

if ($ValidateOnly) {
    Write-Output 'MUC_ALERT_VALIDATE_OK'
    exit 0
}

$titleText = Decode-Text $TitleBase64
$detailsText = Decode-Text $DetailsBase64
$speechText = Decode-Text $SpeechBase64
$videoPath = Decode-Text $VideoPathBase64
$RepeatCount = [Math]::Max(1, [Math]::Min(5, $RepeatCount))
$SpeechRate = [Math]::Max(-10, [Math]::Min(10, $SpeechRate))

$window = New-Object System.Windows.Window
$window.Title = 'MUC Score Alert'
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.WindowState = [System.Windows.WindowState]::Maximized
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$window.Topmost = $true
$window.ShowInTaskbar = $true
$window.Background = [System.Windows.Media.Brushes]::Black
$window.Focusable = $true

$root = New-Object System.Windows.Controls.Grid
$window.Content = $root

$media = New-Object System.Windows.Controls.MediaElement
$media.Source = New-Object System.Uri($videoPath, [System.UriKind]::Absolute)
$media.Stretch = [System.Windows.Media.Stretch]::UniformToFill
$media.LoadedBehavior = [System.Windows.Controls.MediaState]::Manual
$media.UnloadedBehavior = [System.Windows.Controls.MediaState]::Manual
$media.Volume = 0
$null = $root.Children.Add($media)

$shade = New-Object System.Windows.Controls.Border
$shade.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(90, 0, 0, 0))
$null = $root.Children.Add($shade)

$layout = New-Object System.Windows.Controls.Grid
$layout.Margin = New-Object System.Windows.Thickness(36)
$null = $layout.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition -Property @{ Height = '190' }))
$null = $layout.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition -Property @{ Height = '*' }))
$null = $layout.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition -Property @{ Height = '95' }))
$null = $root.Children.Add($layout)

$title = New-Object System.Windows.Controls.TextBlock
$title.Text = $titleText
$title.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI')
$title.FontSize = 62
$title.FontWeight = [System.Windows.FontWeights]::Black
$title.TextAlignment = [System.Windows.TextAlignment]::Center
$title.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$title.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(255, 235, 70))
$titleEffect = New-Object System.Windows.Media.Effects.DropShadowEffect
$titleEffect.Color = [System.Windows.Media.Colors]::Red
$titleEffect.BlurRadius = 38
$titleEffect.ShadowDepth = 0
$titleEffect.Opacity = 1
$title.Effect = $titleEffect
[System.Windows.Controls.Grid]::SetRow($title, 0)
$null = $layout.Children.Add($title)

$scorePanel = New-Object System.Windows.Controls.Border
$scorePanel.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
$scorePanel.VerticalAlignment = [System.Windows.VerticalAlignment]::Bottom
$scorePanel.MaxWidth = 1700
$scorePanel.Margin = New-Object System.Windows.Thickness(20, 20, 20, 20)
$scorePanel.Padding = New-Object System.Windows.Thickness(42, 24, 42, 24)
$scorePanel.CornerRadius = New-Object System.Windows.CornerRadius(28)
$scorePanel.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(155, 20, 0, 0))
$scorePanel.BorderBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(255, 190, 0))
$scorePanel.BorderThickness = New-Object System.Windows.Thickness(3)
[System.Windows.Controls.Grid]::SetRow($scorePanel, 1)
$null = $layout.Children.Add($scorePanel)

$details = New-Object System.Windows.Controls.TextBlock
$details.Text = $detailsText
$details.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI')
$details.FontSize = 34
$details.FontWeight = [System.Windows.FontWeights]::Bold
$details.TextAlignment = [System.Windows.TextAlignment]::Center
$details.TextWrapping = [System.Windows.TextWrapping]::Wrap
$details.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(255, 215, 0))
$detailsEffect = New-Object System.Windows.Media.Effects.DropShadowEffect
$detailsEffect.Color = [System.Windows.Media.Colors]::OrangeRed
$detailsEffect.BlurRadius = 28
$detailsEffect.ShadowDepth = 0
$detailsEffect.Opacity = 0.95
$details.Effect = $detailsEffect
$details.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
$scale = New-Object System.Windows.Media.ScaleTransform(1, 1)
$details.RenderTransform = $scale
$scorePanel.Child = $details

$close = New-Object System.Windows.Controls.Button
$close.Content = 'ESC'
$close.Width = 260
$close.Height = 64
$close.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
$close.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$close.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI')
$close.FontSize = 26
$close.FontWeight = [System.Windows.FontWeights]::Bold
$close.Foreground = [System.Windows.Media.Brushes]::DarkRed
$close.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(230, 255, 235, 120))
$close.BorderThickness = New-Object System.Windows.Thickness(0)
[System.Windows.Controls.Grid]::SetRow($close, 2)
$null = $layout.Children.Add($close)

$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zhVoice = $speaker.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
if ($null -ne $zhVoice) {
    $speaker.SelectVoice($zhVoice.VoiceInfo.Name)
}
$speaker.Volume = 100
$speaker.Rate = $SpeechRate

$script:phase = 0.0
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(55)
$timer.Add_Tick({
    $script:phase += 0.12
    $pulse = (1.0 + 0.035 * [Math]::Sin($script:phase))
    $scale.ScaleX = $pulse
    $scale.ScaleY = $pulse
    $green = [byte](190 + 60 * (([Math]::Sin($script:phase * 1.7) + 1) / 2))
    $details.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(255, $green, 20))
    $detailsEffect.BlurRadius = 22 + 18 * (([Math]::Sin($script:phase * 1.3) + 1) / 2)
    $titleEffect.BlurRadius = 30 + 24 * (([Math]::Sin($script:phase) + 1) / 2)
    $scorePanel.BorderThickness = New-Object System.Windows.Thickness((2 + 2 * (([Math]::Sin($script:phase * 1.5) + 1) / 2)))
})

$autoCloseTimer = New-Object System.Windows.Threading.DispatcherTimer
if ($AutoCloseSeconds -gt 0) {
    $autoCloseTimer.Interval = [TimeSpan]::FromSeconds($AutoCloseSeconds)
    $autoCloseTimer.Add_Tick({
        $autoCloseTimer.Stop()
        $window.Close()
    })
}

$media.Add_MediaEnded({
    $media.Position = [TimeSpan]::Zero
    $media.Play()
})
$media.Add_MediaFailed({
    $media.Visibility = [System.Windows.Visibility]::Hidden
})
$close.Add_Click({ $window.Close() })
$window.Add_KeyDown({
    if ($_.Key -eq [System.Windows.Input.Key]::Escape) {
        $window.Close()
    }
})
$window.Add_ContentRendered({
    [System.IO.File]::WriteAllText($statusLogPath, "WINDOW_SHOWN $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))", [System.Text.Encoding]::UTF8)
    $window.Activate()
    $window.Focus()
    $media.Play()
    $timer.Start()
    [System.Media.SystemSounds]::Exclamation.Play()
    1..$RepeatCount | ForEach-Object { $null = $speaker.SpeakAsync($speechText) }
    if ($AutoCloseSeconds -gt 0) { $autoCloseTimer.Start() }
})
$window.Add_Closed({
    $timer.Stop()
    $autoCloseTimer.Stop()
    $media.Stop()
    $speaker.SpeakAsyncCancelAll()
    $speaker.Dispose()
})

$null = $window.ShowDialog()
