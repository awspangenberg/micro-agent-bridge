# Sends one of Codex's keyboard shortcuts (or writes short text) to the foreground window, only
# when that window is the installed Codex desktop app. Prints one JSON line.
#   -Chord 'Ctrl+Shift+F13' [-Phase tap|down|up]   down/up hold a shortcut (push to talk)
#   -Text ':yolo:'                                   types the text (Codex's composer-text keycaps)
param([string]$Chord, [ValidateSet('tap', 'down', 'up')][string]$Phase = 'tap', [string]$Text)
$ErrorActionPreference = 'Stop'
function Done($row) { $row | ConvertTo-Json -Compress; exit 0 }
try {
  Add-Type -Namespace Mab -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
[DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
'@
  $hwnd = [Mab.Keys]::GetForegroundWindow(); $procId = [uint32]0
  [void][Mab.Keys]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $exe = (Get-Process -Id $procId -ErrorAction SilentlyContinue).Path
  # Only the Microsoft Store Codex app (its window process is ChatGPT.exe in the OpenAI.Codex package).
  # Releasing a held shortcut always goes ahead, so no key is left down if the focus moved.
  if ($Phase -ne 'up' -and (-not $exe -or $exe -notlike '*\WindowsApps\OpenAI.Codex_*')) { Done @{performed = $false; reason = 'foreground-not-codex'} }

  if ($Text) {
    if ($Text.Length -gt 200 -or $Text -match '[\x00-\x1f]') { Done @{performed = $false; reason = 'invalid-text'} }
    $inputs = foreach ($ch in $Text.ToCharArray()) { foreach ($up in 0, 2) {
      $i = New-Object Mab.Keys+INPUT; $i.type = 1; $i.ki.wScan = [uint16][char]$ch; $i.ki.dwFlags = 4 -bor $up; $i } }
    [void][Mab.Keys]::SendInput($inputs.Count, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][Mab.Keys+INPUT]))
    Done @{performed = $true; text = $Text.Length}
  }

  # A chord is up to three modifiers and one key from a fixed set.
  if ($Chord -notmatch '^((Ctrl|Alt|Shift)\+){0,3}(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9]|Enter|Escape|Tab|Space|Left|Right|Up|Down|PageUp|PageDown|Home|End|Delete|Backspace|[\[\];,./`''\\=-])$') { Done @{performed = $false; reason = 'invalid-chord'} }
  $parts = $Chord -split '\+(?=.)'
  $named = @{ Ctrl = 0x11; Alt = 0x12; Shift = 0x10; Enter = 0x0D; Escape = 0x1B; Tab = 0x09; Space = 0x20; Left = 0x25; Up = 0x26; Right = 0x27; Down = 0x28
    PageUp = 0x21; PageDown = 0x22; Home = 0x24; End = 0x23; Delete = 0x2E; Backspace = 0x08
    '[' = 0xDB; ']' = 0xDD; ';' = 0xBA; ',' = 0xBC; '.' = 0xBE; '/' = 0xBF; '`' = 0xC0; "'" = 0xDE; '\' = 0xDC; '=' = 0xBB; '-' = 0xBD }
  $keys = foreach ($p in $parts) {
    if ($named.ContainsKey($p)) { $named[$p] } elseif ($p -match '^F(\d+)$') { 0x6F + [int]$Matches[1] } else { [int][char]$p.ToUpper() }
  }
  # Don't combine with modifiers a person is physically holding.
  if ($Phase -ne 'up') { foreach ($vk in 0x10, 0x11, 0x12, 0x5B, 0x5C) { if ([Mab.Keys]::GetAsyncKeyState($vk) -band 0x8000) { Done @{performed = $false; reason = 'modifier-held'} } } }
  if ($Phase -ne 'up') { foreach ($vk in $keys) { [Mab.Keys]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) } }
  if ($Phase -ne 'down') { [array]::Reverse($keys); foreach ($vk in $keys) { [Mab.Keys]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) } }
  Done @{performed = $true; chord = $Chord; phase = $Phase}
} catch { Done @{performed = $false; reason = 'error'; detail = $_.Exception.Message} }
