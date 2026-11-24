param(
    [Parameter(Mandatory=$true)][string]$Bike,
    [Parameter(Mandatory=$true)][string]$VideoTitle,
    [Parameter(Mandatory=$true)][string]$BookTitle,
    [string]$Output = "showcase-output"
)
$ErrorActionPreference = "Stop"
$pkg = "com.fitbaus.bikebridge.showcase"
$component = "$pkg/com.fitbaus.bikebridge.host.NativeBridgeActivity"
$run = [guid]::NewGuid().ToString("N")
$remote = "/sdcard/fitbaus-showcase-$run.mp4"
function Invoke-Bike {
    & adb -s $Bike @args
    if ($LASTEXITCODE -ne 0) { throw "ADB failed: $args" }
}
function Quote-Remote([string]$s) {
    "'" + $s.Replace("'", "'\''") + "'"
}
New-Item -ItemType Directory -Force $Output | Out-Null
Invoke-Bike shell pm path $pkg
Invoke-Bike shell am force-stop com.fitbaus.bikebridge
Invoke-Bike shell am force-stop $pkg
Invoke-Bike shell am start -n $component
Start-Sleep -Seconds 3
$record = Start-Process adb -ArgumentList @("-s", $Bike, "shell", "screenrecord", "--time-limit", "180", "--bit-rate", "2000000", $remote) -PassThru -NoNewWindow
try {
    Start-Sleep -Seconds 2
    $cmd = "am start -n $component -a $pkg.RUN --es run $run --es video $(Quote-Remote $VideoTitle) --es book $(Quote-Remote $BookTitle)"
    Invoke-Bike shell $cmd
    if (-not $record.WaitForExit(195000)) { throw "screenrecord did not finish" }
    if ($record.ExitCode -ne 0) { throw "screenrecord failed" }
    $log = Invoke-Bike logcat -d -s FitBausShowcase:I
    $outFile = Join-Path $Output "fitbaus-showcase.mp4"
    Invoke-Bike pull $remote $outFile
    if (-not ($log -match "DONE $run")) { throw "Showcase did not complete; inspect $outFile and logcat" }
    Invoke-Bike shell rm $remote
    Write-Output $outFile
} finally {
    if (-not $record.HasExited) { $record.Kill() }
    Invoke-Bike shell am force-stop $pkg
}
