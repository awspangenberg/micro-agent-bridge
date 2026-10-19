; Per-user Windows installer for the standalone Micro host. Built by packaging/build_windows.py,
; which passes AppVersion, NumericVersion, SourceDir, OutputDir and OutputBase.
#ifndef AppVersion
  #error Build with packaging/build_windows.py
#endif
#define AppName "Micro Agent Bridge"
#define Launcher "{app}\bin\micro-agent-bridge.cmd"
#define StateBase "{localappdata}\Micro Agent Bridge"

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
UninstallDisplayIcon={sys}\main.cpl
SetupLogging=yes

[Tasks]
Name: startup; Description: "Start the Micro host at sign-in (supervised; quit Codex and Work Louder Input first on the first run)"; Flags: unchecked
Name: addpath; Description: "Add the micro-agent-bridge command to my PATH"; Flags: unchecked

[InstallDelete]
; Replace program files wholesale on upgrade. State, backups and ownership records live elsewhere.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\docs"
Type: filesandordirs; Name: "{app}\bin"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Start Micro host"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" start --supervise"""; WorkingDir: "{app}"; Comment: "Owns the Codex Micro until Ctrl+C"
Name: "{group}\First-run setup (configure profile)"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" start --supervise --configure-profile --consent"""; WorkingDir: "{app}"; Comment: "Backs up the keyboard profile, maps task rows, then starts the host"
Name: "{group}\Doctor"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" doctor"""; WorkingDir: "{app}"
Name: "{group}\Device status"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" status"""; WorkingDir: "{app}"
Name: "{group}\Restore keyboard profile"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" restore-profile"""; WorkingDir: "{app}"
Name: "{group}\Enable Claude status hooks"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" hooks install"""; WorkingDir: "{app}"
Name: "{group}\Remove Claude status hooks"; Filename: "{cmd}"; Parameters: "/k """"{#Launcher}"" hooks remove"""; WorkingDir: "{app}"
Name: "{group}\Windows guide"; Filename: "https://github.com/awspangenberg/micro-agent-bridge/blob/v{#AppVersion}/docs/windows.md"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{cmd}"" /c start ""{#AppName}"" /min ""{#Launcher}"" start --supervise"; Tasks: startup; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "{#AppName}"; Tasks: not startup; Flags: deletevalue

[UninstallRun]
; Remove only hooks this package installed; leave settings.json untouched otherwise.
Filename: "{app}\runtime\python\python.exe"; Parameters: "-B -I ""{app}\src\claude_hooks.py"" --remove --state ""{#StateBase}\standalone"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveClaudeHooks"; Check: OwnedHooksInstalled

[UninstallDelete]
; Python caches created at run time. The state directory (profile backups) is kept for restore.
Type: filesandordirs; Name: "{app}"

[Code]
const
  EnvKey = 'Environment';

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

function RefuseWhileRunning(): Boolean;
begin
  Result := HostRunning();
  if Result then
    SuppressibleMsgBox('The Micro host is running. Stop it with Ctrl+C in its window (this releases the keyboard), then run this again.',
      mbError, MB_OK, IDOK);
end;

function InitializeSetup(): Boolean;
begin
  Result := not RefuseWhileRunning();
end;

function InitializeUninstall(): Boolean;
begin
  Result := not RefuseWhileRunning();
end;

function OwnedHooksInstalled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{#StateBase}\standalone\hook-command.json'));
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
  if CurStep = ssPostInstall then SetUserPath(WizardIsTaskSelected('addpath'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then SetUserPath(False);
end;
