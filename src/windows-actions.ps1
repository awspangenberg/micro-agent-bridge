# Task-bound Claude desktop actions through UI Automation. Acts only when the foreground window
# is the installed Claude app and its document URL names one of the allowed sessions, and only on
# controls found by their accessible names. No keystrokes are sent, except Escape to close a menu
# this script opened and arrow keys inside such a menu. Prints one JSON line.
#   -Op invoke      invoke the one visible, enabled button named in -Names
#   -Op on|off      toggle that button on/off (hold-to-use buttons such as dictation)
#   -Op menu-toggle open the menu whose button name starts with -Names, toggle the item -Arg
#   -Op effort      open -Names[0] (model menu), its -Names[1] submenu, move the level by -Arg (+1/-1)
#   -Op plan        open the permission-mode menu (button named one of -Names); choose -Arg, or
#                   when -Arg is already chosen, the mode chosen before it
#   -Op scroll      scroll the conversation by a page, -Arg -1 (up) or 1 (down)
param([Parameter(Mandatory)][ValidateSet('invoke', 'on', 'off', 'menu-toggle', 'effort', 'plan', 'scroll')][string]$Op,
      [string]$Names = '-', [Parameter(Mandatory)][string]$Ids, [string]$Arg = '-')
$ErrorActionPreference = 'Stop'
function Done($row) { $row | ConvertTo-Json -Compress; exit 0 }
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -Namespace Mab -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
  $A = [Windows.Automation.AutomationElement]; $CT = [Windows.Automation.ControlType]
  $labels = $Names -split '\|' | Where-Object { $_ -and $_ -ne '-' }
  $sessions = $Ids -split '\|' | Where-Object { $_ -match '^(session_[A-Za-z0-9]{1,128}|local_[0-9a-f-]{36})$' }
  if (-not $sessions) { Done @{performed = $false; reason = 'invalid-request'} }
  $hwnd = [Mab.Win]::GetForegroundWindow(); $procId = [uint32]0
  [void][Mab.Win]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $exe = (Get-Process -Id $procId -ErrorAction SilentlyContinue).Path
  # Only the installed Claude desktop app (Store package or per-user install).
  if (-not $exe -or [IO.Path]::GetFileName($exe) -ne 'claude.exe' -or ($exe -notlike '*\WindowsApps\Claude_*\app\claude.exe' -and $exe -notlike '*\AnthropicClaude\*')) { Done @{performed = $false; reason = 'foreground-not-claude'} }
  $root = $A::FromHandle($hwnd)
  $bound = @()
  foreach ($d in $root.FindAll('Descendants', (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Document)))) {
    $vp = $null
    if (-not $d.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { continue }
    try { $uri = [Uri]$vp.Current.Value } catch { continue }
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'claude.ai') { continue }
    if ($sessions -contains $uri.AbsolutePath.TrimEnd('/').Split('/')[-1]) { $bound += $d }
  }
  if ($bound.Count -ne 1) { Done @{performed = $false; reason = 'task-not-bound'} }

  function Visible($type, $match) {
    @($root.FindAll('Descendants', (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type))) |
      Where-Object { (& $match $_.Current.Name) -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
  }
  # Menus may open in their own popup windows of the same process.
  function InMenus($type) {
    $popups = @($A::RootElement.FindAll('Children', [Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ProcessId -eq $procId })
    @($popups | ForEach-Object { $_.FindAll('Descendants', (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type))) } | Where-Object { -not $_.Current.IsOffscreen })
  }
  function Pattern($e, $p) { $o = $null; if ($e.TryGetCurrentPattern($p, [ref]$o)) { $o } else { $null } }
  function Key($vk) { [Mab.Win]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero); [Mab.Win]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }
  function Open($prefixes) {
    $b = @(Visible $CT::Button { param($n) $n -and @($prefixes | Where-Object { $n -eq $_ -or $n.StartsWith($_) }).Count })
    if ($b.Count -ne 1) { Done @{performed = $false; reason = "menu-opener-$($b.Count)"} }
    $ec = Pattern $b[0] ([Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($ec) { $ec.Expand() } else { (Pattern $b[0] ([Windows.Automation.InvokePattern]::Pattern)).Invoke() }
    Start-Sleep -Milliseconds 350
    return $b[0]
  }
  function Close { Key 0x1B; Start-Sleep -Milliseconds 120 }
  function Select($e) {
    $si = Pattern $e ([Windows.Automation.SelectionItemPattern]::Pattern)
    if ($si) { $si.Select() } else { $ip = Pattern $e ([Windows.Automation.InvokePattern]::Pattern); if ($ip) { $ip.Invoke() } else { return $false } }
    return $true
  }

  switch ($Op) {
    'scroll' {
      $areas = @($bound[0].FindAll('Descendants', [Windows.Automation.Condition]::TrueCondition) | Where-Object { $s = Pattern $_ ([Windows.Automation.ScrollPattern]::Pattern); $s -and $s.Current.VerticallyScrollable } |
        Sort-Object { $_.Current.BoundingRectangle.Height } -Descending)
      if (-not $areas) { Done @{performed = $false; reason = 'no-scroll-area'} }
      $sp = Pattern $areas[0] ([Windows.Automation.ScrollPattern]::Pattern)
      $sp.ScrollVertical($(if ([int]$Arg -lt 0) { [Windows.Automation.ScrollAmount]::LargeDecrement } else { [Windows.Automation.ScrollAmount]::LargeIncrement }))
      Done @{performed = $true; scrolled = [int]$Arg}
    }
    'menu-toggle' {
      [void](Open $labels)
      $item = @(InMenus $CT::CheckBox | Where-Object { $_.Current.Name -eq $Arg })
      if ($item.Count -ne 1) { Close; Done @{performed = $false; reason = "menu-item-$($item.Count)"} }
      (Pattern $item[0] ([Windows.Automation.TogglePattern]::Pattern)).Toggle()
      Close; Done @{performed = $true; control = $Arg}
    }
    'effort' {
      [void](Open @($labels[0]))
      $sub = @(InMenus $CT::MenuItem | Where-Object { $_.Current.Name -like "$($labels[1])*" })
      if ($sub.Count -ne 1) { Close; Done @{performed = $false; reason = 'effort-menu-not-found'} }
      # The submenu opens from the keyboard: focus its item and press Right.
      $sub[0].SetFocus(); Start-Sleep -Milliseconds 150; Key 0x27; Start-Sleep -Milliseconds 350
      $levels = @(InMenus $CT::RadioButton | Where-Object { (Pattern $_ ([Windows.Automation.SelectionItemPattern]::Pattern)) -and $_.Current.Name -notmatch '^(Opus|Fable|Sonnet|Haiku|Claude|Code)\b' })
      $current = [array]::FindIndex([object[]]$levels, [Predicate[object]]{ param($e) (Pattern $e ([Windows.Automation.SelectionItemPattern]::Pattern)).Current.IsSelected })
      if ($levels.Count -lt 2 -or $current -lt 0) { Close; Close; Done @{performed = $false; reason = 'effort-levels-not-found'} }
      $next = [Math]::Max(0, [Math]::Min($levels.Count - 1, $current + [int]$Arg))
      if ($next -eq $current) { Close; Close; Done @{performed = $false; reason = 'effort-at-limit'} }
      [void](Select $levels[$next]); Start-Sleep -Milliseconds 150
      if (@(InMenus $CT::Menu).Count) { Close }
      Done @{performed = $true; effort = $levels[$next].Current.Name}
    }
    'plan' {
      [void](Open $labels)
      $modes = @(InMenus $CT::RadioButton | Where-Object { $n = $_.Current.Name; @($labels | Where-Object { $n -eq $_ -or $n.StartsWith("$_ ") }).Count })
      $selected = @($modes | Where-Object { (Pattern $_ ([Windows.Automation.SelectionItemPattern]::Pattern)).Current.IsSelected })
      $plan = @($modes | Where-Object { $_.Current.Name -eq $Arg -or $_.Current.Name.StartsWith("$Arg ") })
      if ($plan.Count -ne 1 -or $selected.Count -ne 1) { Close; Done @{performed = $false; reason = 'mode-menu-not-found'} }
      $state = Join-Path $env:LOCALAPPDATA 'Micro Agent Bridge\standalone\claude-mode-before-plan.txt'
      if ($selected[0].Current.Name -eq $plan[0].Current.Name) {
        $previous = if (Test-Path $state) { Get-Content $state -Raw } else { 'Manual' }
        $target = @($modes | Where-Object { $_.Current.Name -eq $previous.Trim() -or $_.Current.Name.StartsWith("$($previous.Trim()) ") })
        if ($target.Count -ne 1) { Close; Done @{performed = $false; reason = 'previous-mode-not-found'} }
        [void](Select $target[0])
      } else {
        $selected[0].Current.Name.Split(' ')[0] | Set-Content $state -NoNewline
        [void](Select $plan[0])
      }
      Start-Sleep -Milliseconds 150
      if (@(InMenus $CT::Menu).Count) { Close }
      Done @{performed = $true}
    }
    default {
      $found = @(Visible $CT::Button { param($n) $labels -contains $n })
      if ($found.Count -ne 1) { Done @{performed = $false; reason = "controls-$($found.Count)"} }
      if ($Op -ne 'invoke') {
        $tp = Pattern $found[0] ([Windows.Automation.TogglePattern]::Pattern)
        if (-not $tp) { Done @{performed = $false; reason = 'not-toggle'} }
        $want = if ($Op -eq 'on') { [Windows.Automation.ToggleState]::On } else { [Windows.Automation.ToggleState]::Off }
        if ($tp.Current.ToggleState -ne $want) { $tp.Toggle() }
        Done @{performed = $true; control = $found[0].Current.Name; state = $Op}
      }
      $ip = Pattern $found[0] ([Windows.Automation.InvokePattern]::Pattern)
      if (-not $ip) { Done @{performed = $false; reason = 'not-invokable'} }
      $ip.Invoke()
      Done @{performed = $true; control = $found[0].Current.Name}
    }
  }
} catch { Done @{performed = $false; reason = 'error'; detail = $_.Exception.Message} }
