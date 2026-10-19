# Sends one of Codex's own keyboard shortcuts to the foreground window, only when that window is
# the installed Codex desktop app. The shortcut comes from a fixed list; nothing else is typed.
# Prints one JSON line.
param([Parameter(Mandatory)][ValidateSet('Ctrl+[', 'Ctrl+]', 'Ctrl+B', 'Ctrl+N', 'Ctrl+Alt+A', 'Enter', 'Escape')][string]$Chord)
$ErrorActionPreference = 'Stop'
function Done($row) { $row | ConvertTo-Json -Compress; exit 0 }
try {
  Add-Type -Namespace Mab -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
  $hwnd = [Mab.Keys]::GetForegroundWindow(); $procId = [uint32]0
  [void][Mab.Keys]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $exe = (Get-Process -Id $procId -ErrorAction SilentlyContinue).Path
  # Only the Microsoft Store Codex app (its window process is ChatGPT.exe in the OpenAI.Codex package).
  if (-not $exe -or $exe -notlike '*\WindowsApps\OpenAI.Codex_*') { Done @{performed = $false; reason = 'foreground-not-codex'} }
  # Don't combine with modifiers a person is physically holding.
  foreach ($vk in 0x10, 0x11, 0x12, 0x5B, 0x5C) { if ([Mab.Keys]::GetAsyncKeyState($vk) -band 0x8000) { Done @{performed = $false; reason = 'modifier-held'} } }
  $keys = @{
    'Ctrl+[' = @(0x11, 0xDB); 'Ctrl+]' = @(0x11, 0xDD); 'Ctrl+B' = @(0x11, 0x42); 'Ctrl+N' = @(0x11, 0x4E)
    'Ctrl+Alt+A' = @(0x11, 0x12, 0x41); 'Enter' = @(0x0D); 'Escape' = @(0x1B)
  }[$Chord]
  foreach ($vk in $keys) { [Mab.Keys]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
  [array]::Reverse($keys)
  foreach ($vk in $keys) { [Mab.Keys]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }
  Done @{performed = $true; chord = $Chord}
} catch { Done @{performed = $false; reason = 'error'} }
