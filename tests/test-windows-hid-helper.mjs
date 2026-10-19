import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Windows power notifications invalidate ownership and prohibit reopening without sleeping or HID IO', {skip: process.platform !== 'win32', timeout: 20000}, async () => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$probe = @'
namespace MicroAgentBridgeTests
{
    public static class PowerProbe
    {
        private const System.Reflection.BindingFlags Hidden = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        private static void Require(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }
        public static string Run()
        {
            var hostType = typeof(MicroAgentBridge.WindowsHidHost);
            var current = hostType.GetField("current", Hidden);
            var failed = hostType.GetField("sessionFailed", Hidden);
            var callback = hostType.GetMethod("OnPowerModeChanged", Hidden);
            var sessionType = hostType.GetNestedType("Session", System.Reflection.BindingFlags.NonPublic);
            var interfaceType = hostType.GetNestedType("Interface", System.Reflection.BindingFlags.NonPublic);
            TextWriter original = Console.Out;
            try
            {
                foreach (PowerModes mode in new[] { PowerModes.StatusChange, PowerModes.Suspend, PowerModes.Resume })
                {
                    var host = new MicroAgentBridge.WindowsHidHost();
                    object session = Activator.CreateInstance(sessionType, true);
                    object item = Activator.CreateInstance(interfaceType, true);
                    // Invalid, non-owning handles and no FileStream: this test cannot open a device.
                    var handle = new SafeFileHandle(new IntPtr(-1), false);
                    interfaceType.GetField("Handle").SetValue(item, handle);
                    ((System.Collections.IList)sessionType.GetField("Interfaces").GetValue(session)).Add(item);
                    current.SetValue(host, session);
                    var events = new StringWriter();
                    Console.SetOut(events);
                    callback.Invoke(host, new object[] { null, new PowerModeChangedEventArgs(mode) });
                    if (mode == PowerModes.StatusChange)
                    {
                        Require(Object.ReferenceEquals(current.GetValue(host), session), "Battery status invalidated ownership.");
                        Require(!(bool)failed.GetValue(host), "Battery status prohibited future opening.");
                        Require(!handle.IsClosed && events.ToString() == "", "Battery status closed a handle or emitted a fault.");
                        hostType.GetMethod("CloseCurrent", Hidden).Invoke(host, null);
                        continue;
                    }
                    Require(current.GetValue(host) == null, "Power transition retained current session.");
                    Require((bool)failed.GetValue(host), "Power transition allowed reopening.");
                    Require((bool)sessionType.GetProperty("IsClosed").GetValue(session, null), "Power transition left session open.");
                    Require(handle.IsClosed, "Power transition left an owned handle alive.");
                    var cancellation = (CancellationTokenSource)sessionType.GetField("Cancellation").GetValue(session);
                    Require(cancellation.IsCancellationRequested, "Power transition failed to cancel pending IO.");
                    var row = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(events.ToString());
                    Require((string)row["event"] == "error", "Missing error event.");
                    Require((string)((Dictionary<string, object>)row["error"])["code"] == "POWER_STATE_CHANGED", "Wrong power fault code.");
                    AssertCannotOpen(hostType, host);
                }
                // A notification before ownership is published must also poison the helper.
                var openingHost = new MicroAgentBridge.WindowsHidHost();
                Console.SetOut(new StringWriter());
                callback.Invoke(openingHost, new object[] { null, new PowerModeChangedEventArgs(PowerModes.Suspend) });
                Require((bool)failed.GetValue(openingHost), "Power transition during opening was ignored.");
                AssertCannotOpen(hostType, openingHost);
                return "power invalidation passed";
            }
            finally { Console.SetOut(original); }
        }
        private static void AssertCannotOpen(Type hostType, object host)
        {
            try
            {
                hostType.GetMethod("Open", Hidden).Invoke(host, new object[] { new Dictionary<string, object>() });
                throw new Exception("Helper reopened after a power transition.");
            }
            catch (System.Reflection.TargetInvocationException error)
            {
                var code = error.InnerException.GetType().GetField("Code");
                Require(code != null && (string)code.GetValue(error.InnerException) == "IO_FAILED", "Open did not fail before reading its arguments.");
            }
        }
    }
}
'@
Add-Type -TypeDefinition ((Get-Content -LiteralPath $env:MAB_HELPER_SOURCE -Raw) + $probe) -ReferencedAssemblies 'System.Web.Extensions'
[MicroAgentBridgeTests.PowerProbe]::Run()
`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env, MAB_HELPER_SOURCE: fileURLToPath(new URL('../src/windows-hid.cs', import.meta.url))}});
  let output = '', diagnostics = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { diagnostics += b; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end();
  assert.equal(await exited, 0, diagnostics);
  assert.equal(output.trim(), 'power invalidation passed');
});

test('Windows exclusive helper compiles, bounds input, rejects unsafe paths and closes without HID IO', {skip: process.platform !== 'win32', timeout: 20000}, async () => {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../src/windows-hid.ps1', import.meta.url))], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', diagnostics = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { diagnostics += b; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end([
    '{malformed',
    JSON.stringify({id: 1, command: 'open', paths: ['C:\\not-a-device'], activePath: 'C:\\not-a-device'}),
    JSON.stringify({id: 2, command: 'write', data: Buffer.alloc(64).toString('base64')}),
    JSON.stringify({id: 3, command: 'close'}), '',
  ].join('\n'));
  assert.equal(await exited, 0, diagnostics);
  const rows = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].error.code, 'PROTOCOL_ERROR');
  assert.equal(rows[1].error.code, 'INVALID_ARGUMENT');
  assert.equal(rows[2].error.code, 'NOT_OPEN');
  assert.deepEqual(rows[3], {id: 3, result: {closed: true}});
});
