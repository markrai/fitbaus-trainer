param(
    [Parameter(Mandatory=$true)][string]$Bike,
    [Parameter(Mandatory=$true)][string]$VideoTitle,
    [Parameter(Mandatory=$true)][string]$BookTitle,
    [string]$Output = "showcase-output",
    [string]$MathPhotos
)
$ErrorActionPreference = "Stop"
if ($VideoTitle -match '^Exact (YouTube )?video title$' -or $BookTitle -match '^Exact audiobook title$') {
    throw "Replace the placeholder media titles before recording."
}
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
$outFile = Join-Path $Output "fitbaus-showcase-$run.mp4"
Invoke-Bike shell pm path $pkg
Invoke-Bike shell am force-stop com.fitbaus.bikebridge
Invoke-Bike shell am force-stop $pkg
Invoke-Bike shell am start -n $component
Start-Sleep -Seconds 3
if ($MathPhotos) {
    $remotePhotos = "/sdcard/Android/data/$pkg/files/showcase-math"
    $names = @("rest.jpg") + @(0..10 | ForEach-Object { "$_.jpg" })
    foreach ($name in $names) {
        if (-not (Test-Path -LiteralPath (Join-Path $MathPhotos $name) -PathType Leaf)) { throw "Missing Math photo: $name" }
    }
    Invoke-Bike shell mkdir -p $remotePhotos
    foreach ($name in $names) {
        Invoke-Bike push (Join-Path $MathPhotos $name) "$remotePhotos/$name"
    }
}
$record = Start-Process adb -ArgumentList @("-s", $Bike, "shell", "screenrecord", "--time-limit", "180", "--bit-rate", "2000000", $remote) -PassThru -NoNewWindow
$failure = $null
try {
    Start-Sleep -Seconds 2
    $cmd = "am start -n $component -a $pkg.RUN --es run $run --es video $(Quote-Remote $VideoTitle) --es book $(Quote-Remote $BookTitle)"
    Invoke-Bike shell $cmd
    if (-not $record.WaitForExit(195000)) { throw "screenrecord did not finish" }
    if ($record.ExitCode -ne 0) { throw "screenrecord exited with code $($record.ExitCode)" }
    $log = Invoke-Bike logcat -d -s FitBausShowcase:I
    if (-not ($log -match "DONE $run")) { throw "Showcase did not complete; inspect logcat" }
} catch {
    $failure = $_
} finally {
    if (-not $record.HasExited) {
        if (-not $record.WaitForExit(185000)) { $record.Kill(); $record.WaitForExit() }
    }
    try {
        Invoke-Bike pull $remote $outFile
        Write-Host "Recovered recording: $outFile"
    } catch {
        Write-Warning "Could not pull recording. Original path: $remote"
        if (-not $failure) { $failure = $_ }
    }
    try { Invoke-Bike shell am force-stop $pkg } catch { Write-Warning "Could not stop showcase" }
}
if ($failure) {
    Write-Warning "Original recording retained at $remote"
    throw $failure
}
Invoke-Bike shell rm $remote
Write-Output $outFile
