; Per-user Windows installer for the standalone Micro host. Built by packaging/build_windows.py,
; which passes AppVersion, NumericVersion, SourceDir, OutputDir, OutputBase and IconFile.
#ifndef AppVersion
  #error Build with packaging/build_windows.py
#endif
#define AppName "Micro Agent Bridge"
#define AppExe "{app}\MicroAgentBridge.exe"
#define Launcher "{app}\bin\micro-agent-bridge.cmd"
#define StateBase "{localappdata}\Micro Agent Bridge"
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"

[Setup]
AppId={{6C1D5E0B-4A8F-4F7B-9E52-3D0B7A1C9F24}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=awspangenberg
AppPublisherURL=https://github.com/awspangenberg/micro-agent-bridge
AppSupportURL=https://github.com/awspangenberg/micro-agent-bridge/issues
VersionInfoVersion={#NumericVersion}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile={#SourceDir}\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={#AppExe}
SetupIconFile={#IconFile}
SetupLogging=yes

[Tasks]
; Starting with Windows is chosen during onboarding, in the app.
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked
Name: addpath; Description: "Add the micro-agent-bridge command line to my PATH"; Flags: unchecked

[InstallDelete]
; Replace program files wholesale on upgrade. State, backups and ownership records live elsewhere.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\docs"
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\ui"
; Console shortcuts from rc.3 and earlier; the app replaces them (a second host would fight it for the Micro).
Type: files; Name: "{group}\Start Micro host.lnk"
Type: files; Name: "{group}\First-run setup (configure profile).lnk"
Type: files; Name: "{group}\Doctor.lnk"
Type: files; Name: "{group}\Device status.lnk"
Type: files; Name: "{group}\Restore keyboard profile.lnk"
Type: files; Name: "{group}\Enable Claude status hooks.lnk"
Type: files; Name: "{group}\Remove Claude status hooks.lnk"
Type: files; Name: "{group}\Windows guide.url"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{#AppExe}"; Comment: "Your pinned Codex and Claude tasks on the Codex Micro"
Name: "{group}\Set up {#AppName}"; Filename: "{#AppExe}"; Parameters: "--setup"; Comment: "Connect, map and test your Codex Micro"
Name: "{group}\Troubleshooting\Doctor"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" doctor"""; WorkingDir: "{app}"
Name: "{group}\Troubleshooting\Device status"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" status"""; WorkingDir: "{app}"
Name: "{group}\Troubleshooting\Windows guide"; Filename: "https://github.com/awspangenberg/micro-agent-bridge/blob/v{#AppVersion}/docs/windows.md"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{#AppExe}"; Tasks: desktopicon

[Run]
; New installs open onboarding; upgrades reopen the app as it was (dashboard and host).
Filename: "{#AppExe}"; Description: "Open {#AppName}"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; The standard library is precompiled at build time; Claude hook runs may still cache src modules.
; Only paths this package owns are removed. The state directory (profile backups) is kept for restore;
; the app's preferences and WebView cache go, so a reinstall starts with onboarding.
Type: filesandordirs; Name: "{app}\src\__pycache__"
Type: dirifempty; Name: "{app}\src"
Type: dirifempty; Name: "{app}"
Type: filesandordirs; Name: "{#StateBase}\webview"
Type: files; Name: "{#StateBase}\app.json"

[Code]
const
  EnvKey = 'Environment';
  AppMutex = 'Local\MicroAgentBridge.App';
  WebView2Client = '\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Installed(): Boolean;
var
  V: string;
begin
  Result := (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node' + WebView2Client, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
            (RegQueryStringValue(HKCU, 'Software' + WebView2Client, 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

// Ask a running tray app to stop its host and exit, then wait for it to go.
function CloseRunningApp(Exe: string): Boolean;
var
  Code, I: Integer;
begin
  Result := True;
  if not CheckForMutexes(AppMutex) then Exit;
  if FileExists(Exe) then Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  for I := 1 to 60 do begin
    if not CheckForMutexes(AppMutex) then Exit;
    Sleep(250);
  end;
  Result := False;
end;

function HostRunning(): Boolean;
var
  Pid: AnsiString;
  Code: Integer;
begin
  Result := False;
  if not LoadStringFromFile(ExpandConstant('{#StateBase}\standalone.pid'), Pid) then Exit;
  Pid := Trim(Pid);
  if (Pid = '') or (StrToIntDef(Pid, 0) < 2) then Exit;
  // Exit code 3 means a Node process still holds the host lock.
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoLogo -NoProfile -NonInteractive -Command "if (Get-Process -Id ' + Pid + ' -ErrorAction SilentlyContinue | Where-Object ProcessName -eq ''node'') { exit 3 } else { exit 0 }"',
      '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Result := Code = 3;
end;

// The tray app is closed for the user; a host started from a terminal must be stopped by them.
function BusyMessage(Exe: string): string;
begin
  Result := '';
  if not CloseRunningApp(Exe) then
    Result := 'Micro Agent Bridge is still running. Quit it from its notification-area icon, then run this again.'
  else if HostRunning() then
    Result := 'A Micro host started from a terminal is running. Stop it with Ctrl+C in its window (this releases the keyboard), then run this again.';
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not WebView2Installed() then
    Result := SuppressibleMsgBox('Micro Agent Bridge needs the Microsoft Edge WebView2 Runtime, which this PC does not seem to have.' + #13#10#13#10 +
      'Windows 11 includes it. On Windows 10, install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 before opening the app.' + #13#10#13#10 +
      'Continue installing?', mbConfirmation, MB_YESNO, IDYES) = IDYES;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := BusyMessage(ExpandConstant('{#AppExe}'));
end;

function ProfileMapped(): Boolean;
var
  Owned: AnsiString;
begin
  Result := LoadStringFromFile(ExpandConstant('{#StateBase}\standalone\standalone-profile-ownership.json'), Owned) and
    (Pos('"state":"configured"', Owned) > 0);
end;

// Offer to put the original key mappings back while the bridge is still installed to do it.
function OfferRestore(): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if UninstallSilent() or not ProfileMapped() then Exit;
  case MsgBox('Restore your Micro''s original keyboard profile before uninstalling?' + #13#10#13#10 +
      'Keep the Micro connected. Choose No to keep the task keys as they are; the backup stays in ' +
      ExpandConstant('{#StateBase}') + '.', mbConfirmation, MB_YESNOCANCEL) of
    IDCANCEL: Result := False;
    IDYES:
      if not Exec(ExpandConstant('{app}\runtime\node\node.exe'),
          ExpandConstant('"{app}\src\standalone-control.mjs" restore-profile --python "{app}\runtime\python\python.exe"'),
          ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
        Result := MsgBox('The profile could not be restored (is the Micro connected, with Codex and Work Louder Input closed?).' + #13#10#13#10 +
          'Uninstall anyway? The backup stays in ' + ExpandConstant('{#StateBase}') + '.', mbError, MB_YESNO) = IDYES;
  end;
end;

function InitializeUninstall(): Boolean;
var
  Message: string;
begin
  Message := BusyMessage(ExpandConstant('{#AppExe}'));
  Result := Message = '';
  if not Result then SuppressibleMsgBox(Message, mbError, MB_OK, IDOK)
  else Result := OfferRestore();
end;

// rc.3 and earlier started a console host at sign-in; keep the user's choice but start the app instead.
procedure MigrateSignInStart();
var
  Value: string;
begin
  if RegQueryStringValue(HKCU, '{#RunKey}', '{#AppName}', Value) and (Pos('micro-agent-bridge.cmd', Lowercase(Value)) > 0) then
    RegWriteStringValue(HKCU, '{#RunKey}', '{#AppName}', '"' + ExpandConstant('{#AppExe}') + '" --background');
end;

// Removes only hooks this package installed, and only when its ownership record exists, so
// settings.json is untouched otherwise. Decided at uninstall time ([UninstallRun] Check runs at install).
procedure RemoveOwnedHooks();
var
  Code: Integer;
begin
  if not FileExists(ExpandConstant('{#StateBase}\standalone\hook-command.json')) then Exit;
  if not Exec(ExpandConstant('{app}\runtime\python\python.exe'),
      ExpandConstant('-B -E -s "{app}\src\claude_hooks.py" --remove --state "{#StateBase}\standalone"'),
      '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    SuppressibleMsgBox('Claude status hooks could not be removed automatically. Remove the Micro Agent Bridge entries from ' +
      ExpandConstant('{%USERPROFILE}') + '\.claude\settings.json.', mbError, MB_OK, IDOK);
end;

function PathWithout(Path, Dir: string): string;
var
  Rest, Item: string;
  P: Integer;
begin
  Result := '';
  Rest := Path + ';';
  while Rest <> '' do begin
    P := Pos(';', Rest);
    Item := Copy(Rest, 1, P - 1);
    Delete(Rest, 1, P);
    if (Item <> '') and (CompareText(RemoveBackslashUnlessRoot(Item), RemoveBackslashUnlessRoot(Dir)) <> 0) then begin
      if Result <> '' then Result := Result + ';';
      Result := Result + Item;
    end;
  end;
end;

procedure SetUserPath(Add: Boolean);
var
  Original, Path, Dir: string;
begin
  Dir := ExpandConstant('{app}\bin');
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Original) then begin
    if not Add then Exit;
    Original := '';
  end;
  Path := PathWithout(Original, Dir);
  if Add then begin
    if Path <> '' then Path := Path + ';';
    Path := Path + Dir;
  end;
  if Path <> Original then RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Path);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    SetUserPath(WizardIsTaskSelected('addpath'));
    MigrateSignInStart();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    RemoveOwnedHooks();
    SetUserPath(False);
    RegDeleteValue(HKCU, '{#RunKey}', '{#AppName}');
  end;
end;
