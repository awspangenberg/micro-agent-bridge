# Task-bound Claude desktop action via UI Automation. Read-only except for invoking (or, for
# hold-to-use buttons, toggling on or off) exactly one enabled button in the foreground Claude
# window whose document URL names one of the allowed sessions. No keystrokes are injected.
# Prints one JSON line.
param([Parameter(Mandatory)][string]$Names, [Parameter(Mandatory)][string]$Ids,
      [ValidateSet('invoke', 'on', 'off')][string]$Mode = 'invoke')
$ErrorActionPreference = 'Stop'
function Done($row) { $row | ConvertTo-Json -Compress; exit 0 }
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -Namespace Mab -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
'@
  $labels = $Names -split '\|' | Where-Object { $_ }
  $sessions = $Ids -split '\|' | Where-Object { $_ -match '^(session_[A-Za-z0-9]{1,128}|local_[0-9a-f-]{36})$' }
  if (-not $labels -or -not $sessions) { Done @{performed = $false; reason = 'invalid-request'} }
  $hwnd = [Mab.Win]::GetForegroundWindow(); $procId = [uint32]0
  [void][Mab.Win]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  $exe = $proc.Path
  # Only the installed Claude desktop app (Store package or per-user install).
  if (-not $exe -or [IO.Path]::GetFileName($exe) -ne 'claude.exe' -or ($exe -notlike '*\WindowsApps\Claude_*\app\claude.exe' -and $exe -notlike '*\AnthropicClaude\*')) { Done @{performed = $false; reason = 'foreground-not-claude'} }
  $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $docCond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Document)
  $bound = @()
  foreach ($d in $root.FindAll([Windows.Automation.TreeScope]::Descendants, $docCond)) {
    $vp = $null
    if (-not $d.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { continue }
    try { $uri = [Uri]$vp.Current.Value } catch { continue }
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'claude.ai') { continue }
    $last = $uri.AbsolutePath.TrimEnd('/').Split('/')[-1]
    if ($sessions -contains $last) { $bound += $d }
  }
  if ($bound.Count -ne 1) { Done @{performed = $false; reason = 'task-not-bound'} }
  $btnCond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
  $found = @($root.FindAll([Windows.Automation.TreeScope]::Descendants, $btnCond) | Where-Object { $labels -contains $_.Current.Name -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
  if ($found.Count -ne 1) { Done @{performed = $false; reason = "controls-$($found.Count)"} }
  if ($Mode -ne 'invoke') {
    $tp = $null
    if (-not $found[0].TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) { Done @{performed = $false; reason = 'not-toggle'} }
    $want = if ($Mode -eq 'on') { [Windows.Automation.ToggleState]::On } else { [Windows.Automation.ToggleState]::Off }
    if ($tp.Current.ToggleState -ne $want) { $tp.Toggle() }
    Done @{performed = $true; control = $found[0].Current.Name; state = $Mode}
  }
  $ip = $null
  if (-not $found[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { Done @{performed = $false; reason = 'not-invokable'} }
  $ip.Invoke()
  Done @{performed = $true; control = $found[0].Current.Name}
} catch { Done @{performed = $false; reason = 'error'} }
