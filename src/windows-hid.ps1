# The transport deliberately runs under Windows PowerShell 5.1, whose framework
# includes System.Web.Extensions. Loading/compiling this file does not open HID.
$ErrorActionPreference = 'Stop'
try {
    if ($PSVersionTable.PSEdition -ne 'Desktop') {
        throw 'Run this helper with Windows PowerShell 5.1 (powershell.exe).'
    }
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-hid.cs') -ReferencedAssemblies 'System.Web.Extensions' -ErrorAction Stop
    $transportExitCode = [MicroAgentBridge.WindowsHidHost]::Run()
    exit $transportExitCode
}
catch {
    [Console]::Error.WriteLine('Windows HID helper failed: ' + $_.Exception.Message)
    exit 1
}
