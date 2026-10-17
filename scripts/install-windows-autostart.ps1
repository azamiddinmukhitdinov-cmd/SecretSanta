param(
    [string]$Account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [switch]$EnableTailscaleUnattended
)

$ErrorActionPreference = 'Stop'
$santaRoot = Split-Path -Parent $PSScriptRoot
$santaLogDirectory = Join-Path $santaRoot 'data\setup'
New-Item -ItemType Directory -Path $santaLogDirectory -Force | Out-Null
Start-Transcript -Path (Join-Path $santaLogDirectory 'autostart.log') -Append | Out-Null
$santaIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$santaPrincipal = [System.Security.Principal.WindowsPrincipal]::new($santaIdentity)
if (-not $santaPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an Administrator PowerShell window.'
}

$santaNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$santaNodePath = if ($santaNodeCommand) { $santaNodeCommand.Source } else {
    Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $santaNodePath -PathType Leaf)) {
    throw 'Node.js 24 or newer was not found.'
}
$santaLauncher = Join-Path $PSScriptRoot 'run-windows.mjs'
$santaAction = New-ScheduledTaskAction -Execute $santaNodePath -Argument ('"{0}" start' -f $santaLauncher) -WorkingDirectory $santaRoot
$santaTrigger = New-ScheduledTaskTrigger -AtStartup
$santaTrigger.Delay = 'PT20S'
# S4U runs as the organizer without storing their Windows password.
# The web app only needs local files and localhost; Funnel runs in its own service.
$santaTaskPrincipal = New-ScheduledTaskPrincipal -UserId $Account -LogonType S4U -RunLevel Limited
$santaSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$santaExistingTask = Get-ScheduledTask -TaskName 'SecretSanta-Web' -ErrorAction SilentlyContinue
if ($santaExistingTask) {
    if ($santaExistingTask.Actions.Count -ne 1 -or $santaExistingTask.Actions[0].Execute -ne $santaNodePath -or $santaExistingTask.Actions[0].Arguments -ne $santaAction.Arguments) {
        throw 'A different SecretSanta-Web task already exists. Review it before replacing it.'
    }
    Write-Output 'SecretSanta-Web is already registered for this project.'
} else {
    Register-ScheduledTask -TaskName 'SecretSanta-Web' -Action $santaAction -Trigger $santaTrigger -Principal $santaTaskPrincipal -Settings $santaSettings -Description 'Family Secret Santa web app; local data and hosting config in the project data folder.' | Out-Null
    Write-Output 'Registered SecretSanta-Web. It will run 20 seconds after Windows starts.'
}

if ($EnableTailscaleUnattended) {
    $santaTailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (-not (Test-Path -LiteralPath $santaTailscale -PathType Leaf)) {
        throw 'Tailscale was not found.'
    }
    & $santaTailscale set --unattended=true
    if ($LASTEXITCODE -ne 0) { throw 'Could not enable Tailscale unattended mode.' }
    Write-Output 'Tailscale unattended mode is enabled.'
}
Stop-Transcript | Out-Null
