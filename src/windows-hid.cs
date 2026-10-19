// A process-owned Windows HID transport. Every supplied RPC interface is held
// with share mode zero; there is no shared or feature-only open fallback.
// Wire format: {id,command:"open",paths:[...],activePath:"..."},
// {id,command:"write",data:"base64"}, or {id,command:"close"}.
// Reports include their report-ID byte. This protocol supports 64-byte reports.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace MicroAgentBridge
{
    public sealed class WindowsHidHost
    {
        private const int ReportLength = 64;
        private const int WriteDeadlineMilliseconds = 10000;
        private const int MaximumLineLength = 32768;
        private const int MaximumPaths = 16;
        private readonly object outputLock = new object();
        private readonly object sessionLock = new object();
        private readonly JavaScriptSerializer inputJson = NewSerializer();
        private readonly JavaScriptSerializer outputJson = NewSerializer();
        private Session current;
        private bool sessionFailed;

        private static JavaScriptSerializer NewSerializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = MaximumLineLength, RecursionLimit = 8 };
        }

        public static int Run()
        {
            // PowerShell starts in STA. Framework SystemEvents would attach its
            // window to that blocked thread instead of starting a message pump.
            // A pool thread is MTA and has no captured UI synchronization context.
            return Task.Run(() => new WindowsHidHost().RunLoop()).GetAwaiter().GetResult();
        }

        private int RunLoop()
        {
            bool observingPower = false;
            try
            {
                SystemEvents.PowerModeChanged += OnPowerModeChanged;
                observingPower = true;
                var eventsReady = new TaskCompletionSource<bool>();
                SystemEvents.InvokeOnEventsThread((Action)(() => eventsReady.TrySetResult(true)));
                if (!eventsReady.Task.Wait(2000))
                    throw Fault("POWER_EVENTS_UNAVAILABLE", "Windows power notifications are not being dispatched.");
                string line;
                while ((line = ReadBoundedLine()) != null)
                {
                    object id = null;
                    try
                    {
                        var request = inputJson.DeserializeObject(line) as Dictionary<string, object>;
                        if (request == null) throw Fault("INVALID_COMMAND", "Expected a JSON object.");
                        id = ReadId(request);
                        string command = StringField(request, "command");
                        if (command == "open")
                        {
                            CheckKeys(request, "id", "command", "paths", "activePath");
                            Session session = Open(request);
                            Reply(id, session.Describe());
                            // The successful ownership acknowledgement precedes incoming reports.
                            session.Reader = Task.Run(() => ReadReports(session));
                        }
                        else if (command == "write")
                        {
                            CheckKeys(request, "id", "command", "data");
                            WriteReport(StringField(request, "data"));
                            Reply(id, new { written = ReportLength });
                        }
                        else if (command == "close")
                        {
                            CheckKeys(request, "id", "command");
                            CloseCurrent();
                            Reply(id, new { closed = true });
                            return 0;
                        }
                        else throw Fault("INVALID_COMMAND", "Unknown command.");
                    }
                    catch (Exception error)
                    {
                        ReplyError(id, error);
                    }
                }
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Windows HID transport stopped: " + error.Message);
                return 1;
            }
            finally
            {
                try { if (observingPower) SystemEvents.PowerModeChanged -= OnPowerModeChanged; }
                finally { CloseCurrent(); }
            }
        }

        private static string ReadBoundedLine()
        {
            var line = new StringBuilder();
            while (true)
            {
                int next = Console.In.Read();
                if (next < 0) return line.Length == 0 ? null : line.ToString();
                if (next == '\n') return line.ToString();
                if (line.Length == MaximumLineLength)
                    throw Fault("PROTOCOL_ERROR", "Input line exceeds the transport limit.");
                line.Append((char)next);
            }
        }

        private static object ReadId(Dictionary<string, object> request)
        {
            object id;
            if (!request.TryGetValue("id", out id)) throw Fault("INVALID_COMMAND", "A request id is required.");
            string text = id as string;
            if (text != null && text.Length > 0 && text.Length <= 128) return text;
            if (id is int || id is long)
            {
                long number = Convert.ToInt64(id);
                if (number >= 0 && number <= 9007199254740991L) return id;
            }
            throw Fault("INVALID_COMMAND", "Request id must be a short string or nonnegative safe integer.");
        }

        private static string StringField(Dictionary<string, object> request, string name)
        {
            object value;
            if (!request.TryGetValue(name, out value) || !(value is string))
                throw Fault("INVALID_ARGUMENT", "Expected string field: " + name);
            return (string)value;
        }

        private static void CheckKeys(Dictionary<string, object> request, params string[] allowed)
        {
            var keys = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (string key in request.Keys)
                if (!keys.Contains(key)) throw Fault("INVALID_ARGUMENT", "Unexpected request field.");
        }

        private Session Open(Dictionary<string, object> request)
        {
            lock (sessionLock)
            {
                if (sessionFailed) throw Fault("IO_FAILED", "Restart the helper after a device I/O or power-state change.");
                if (current != null) throw Fault("ALREADY_OPEN", "Close the existing session before opening another.");
            }
            object pathsValue;
            if (!request.TryGetValue("paths", out pathsValue) || !(pathsValue is object[]))
                throw Fault("INVALID_ARGUMENT", "paths must be an array.");
            var requested = (object[])pathsValue;
            if (requested.Length == 0 || requested.Length > MaximumPaths)
                throw Fault("INVALID_ARGUMENT", "Expected between one and sixteen interface paths.");
            string activePath = StringField(request, "activePath");
            var unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var paths = new List<string>();
            foreach (object value in requested)
            {
                string path = value as string;
                if (!IsMicroHidPath(path) || !unique.Add(path))
                    throw Fault("INVALID_ARGUMENT", "Expected unique Micro HID interface paths.");
                paths.Add(path);
            }
            if (!unique.Contains(activePath))
                throw Fault("INVALID_ARGUMENT", "activePath must be one of the owned interfaces.");
            paths.Sort(StringComparer.OrdinalIgnoreCase);
            var session = new Session();
            try
            {
                // Acquire every interface before reading, writing, or acknowledging ownership.
                foreach (string path in paths)
                {
                    SafeFileHandle handle = Native.CreateFile(path, 0xC0000000, 0,
                        IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
                    if (handle.IsInvalid)
                    {
                        int code = Marshal.GetLastWin32Error();
                        handle.Dispose();
                        throw Fault("HID_OPEN_FAILED", "Exclusive HID open failed (" + code + "): " + new Win32Exception(code).Message);
                    }
                    var item = new Interface { Path = path, Handle = handle };
                    session.Interfaces.Add(item);
                    ValidateInterface(item);
                    if (String.Equals(path, activePath, StringComparison.OrdinalIgnoreCase))
                    {
                        // Framework FileStream buffers writes equal to its buffer size.
                        // A one-byte buffer makes every complete HID report go directly
                        // to WriteFile instead of waiting for a later flush/read.
                        item.Stream = new FileStream(handle, FileAccess.ReadWrite, 1, true);
                        session.Active = item;
                    }
                }
                lock (sessionLock)
                {
                    // A power notification may arrive while native opens/capability
                    // checks run. Never publish that session after invalidation.
                    if (sessionFailed)
                        throw Fault("IO_FAILED", "The power state changed while opening; restart the helper.");
                    current = session;
                }
                return session;
            }
            catch { session.Close(); throw; }
        }

        private static bool IsMicroHidPath(string path)
        {
            if (String.IsNullOrEmpty(path) || path.Length > 2048 ||
                !path.StartsWith(@"\\?\hid#", StringComparison.OrdinalIgnoreCase)) return false;
            foreach (char c in path) if (Char.IsControl(c)) return false;
            string lower = path.ToLowerInvariant();
            bool usbVendor = lower.Contains("vid_303a");
            bool bluetoothVendor = lower.Contains("vid&02303a");
            return (usbVendor && lower.Contains("pid_8360")) ||
                (bluetoothVendor && lower.Contains("pid&8360"));
        }

        private static void ValidateInterface(Interface item)
        {
            var attributes = new Native.Attributes { Size = Marshal.SizeOf(typeof(Native.Attributes)) };
            if (!Native.HidD_GetAttributes(item.Handle, ref attributes))
                throw Fault("HID_UNSUPPORTED", "Cannot read HID device attributes.");
            if (attributes.VendorID != 0x303a || attributes.ProductID != 0x8360)
                throw Fault("HID_UNSUPPORTED", "The interface is not a Codex Micro device.");
            IntPtr preparsed;
            if (!Native.HidD_GetPreparsedData(item.Handle, out preparsed))
                throw Fault("HID_UNSUPPORTED", "Cannot inspect HID report capabilities.");
            Native.Capabilities capabilities;
            try
            {
                if (Native.HidP_GetCaps(preparsed, out capabilities) != 0x00110000)
                    throw Fault("HID_UNSUPPORTED", "Cannot inspect HID report capabilities.");
            }
            finally { Native.HidD_FreePreparsedData(preparsed); }
            if (capabilities.UsagePage != 0xff00 || capabilities.InputReportByteLength != ReportLength ||
                capabilities.OutputReportByteLength != ReportLength)
                throw Fault("HID_UNSUPPORTED", "Expected a vendor RPC collection with 64-byte input/output reports.");
            item.VendorId = attributes.VendorID;
            item.ProductId = attributes.ProductID;
            item.UsagePage = capabilities.UsagePage;
        }

        private void WriteReport(string encoded)
        {
            if (encoded.Length != 88) throw Fault("INVALID_ARGUMENT", "Expected one base64-encoded 64-byte report.");
            byte[] report;
            try { report = Convert.FromBase64String(encoded); }
            catch (FormatException) { throw Fault("INVALID_ARGUMENT", "Invalid base64 report."); }
            if (report.Length != ReportLength || Convert.ToBase64String(report) != encoded)
                throw Fault("INVALID_ARGUMENT", "Expected one canonical base64-encoded 64-byte report.");
            Session session;
            lock (sessionLock) { session = current; }
            if (session == null || session.IsClosed) throw Fault("NOT_OPEN", "No exclusive HID session is open.");
            try
            {
                // RunLoop processes commands serially; no two writes can overlap.
                using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(session.Cancellation.Token))
                {
                    deadline.CancelAfter(WriteDeadlineMilliseconds);
                    Task write = session.Active.Stream.WriteAsync(report, 0, report.Length, deadline.Token);
                    Task expired = Task.Delay(Timeout.Infinite, deadline.Token);
                    // Cancellation requests alone need not complete a driver operation.
                    // Bound the wait as well, so a dead parent's stdin EOF is reached
                    // within ten seconds even if the outstanding native write hangs.
                    if (Task.WhenAny(write, expired).GetAwaiter().GetResult() != write)
                    {
                        Native.CancelIoEx(session.Active.Handle, IntPtr.Zero);
                        write.ContinueWith(task => { var ignored = task.Exception; },
                            TaskContinuationOptions.OnlyOnFaulted);
                        throw new TimeoutException("HID write was canceled or exceeded its ten-second deadline.");
                    }
                    write.GetAwaiter().GetResult();
                }
            }
            catch (Exception error)
            {
                LoseSession(session, "HID write failed: " + error.Message);
                throw Fault("IO_FAILED", "HID write failed; every owned interface was released.");
            }
        }

        private async Task ReadReports(Session session)
        {
            try
            {
                var report = new byte[ReportLength];
                while (!session.IsClosed)
                {
                    int length = await session.Active.Stream.ReadAsync(report, 0, report.Length,
                        session.Cancellation.Token).ConfigureAwait(false);
                    if (session.IsClosed) return;
                    // A zero-length completion means the device link ended (e.g. Bluetooth dropped).
                    if (length == 0) throw new IOException("Micro disconnected (zero-length HID read).");
                    if (length != ReportLength) throw new IOException("Unexpected HID input report length " + length + ".");
                    lock (sessionLock)
                    {
                        // Closing a session invalidates all its reports before the close reply.
                        if (!Object.ReferenceEquals(current, session) || session.IsClosed) return;
                        Send(new { @event = "data", data = Convert.ToBase64String(report, 0, length) });
                    }
                }
            }
            catch (Exception error)
            {
                if (!session.IsClosed) LoseSession(session, "HID read failed: " + error.Message);
            }
        }

        private void LoseSession(Session session, string message)
        {
            bool owned;
            lock (sessionLock)
            {
                owned = Object.ReferenceEquals(current, session);
                if (owned) { current = null; sessionFailed = true; }
            }
            session.Close();
            if (owned) Send(new { @event = "error", error = new { code = "IO_FAILED", message = message } });
        }

        private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs args)
        {
            if (args.Mode != PowerModes.Suspend && args.Mode != PowerModes.Resume) return;
            Session session;
            lock (sessionLock)
            {
                // Invalidate even when an open is still in progress. Neither a
                // surviving handle nor an unchanged HID path permits auto-resume.
                sessionFailed = true;
                session = current;
                current = null;
            }
            if (session != null) session.Close();
            try
            {
                Send(new { @event = "error", error = new { code = "POWER_STATE_CHANGED",
                    message = "Windows suspended or resumed; every owned interface was released. Restart the host explicitly." } });
            }
            catch (Exception error) { Console.Error.WriteLine("HID power notification output: " + error.Message); }
        }

        private void CloseCurrent()
        {
            Session session;
            lock (sessionLock) { session = current; current = null; }
            if (session != null) session.Close();
        }

        private void Reply(object id, object result) { Send(new { id = id, result = result }); }
        private void ReplyError(object id, Exception error)
        {
            var transportError = error as TransportException;
            Send(new { id = id, error = new { code = transportError == null ? "PROTOCOL_ERROR" : transportError.Code, message = error.Message } });
        }
        private void Send(object value)
        {
            lock (outputLock)
            {
                Console.Out.WriteLine(outputJson.Serialize(value));
                Console.Out.Flush();
            }
        }

        private static TransportException Fault(string code, string message) { return new TransportException(code, message); }
        private sealed class TransportException : Exception
        {
            public readonly string Code;
            public TransportException(string code, string message) : base(message) { Code = code; }
        }

        private sealed class Interface
        {
            public string Path;
            public SafeFileHandle Handle;
            public FileStream Stream;
            public int VendorId, ProductId, UsagePage;
        }
        private sealed class Session
        {
            public readonly List<Interface> Interfaces = new List<Interface>();
            public readonly CancellationTokenSource Cancellation = new CancellationTokenSource();
            public Interface Active;
            public Task Reader;
            private int closed;
            public bool IsClosed { get { return Interlocked.CompareExchange(ref closed, 0, 0) != 0; } }
            public object Describe()
            {
                var paths = new List<string>();
                var descriptions = new List<object>();
                foreach (Interface item in Interfaces)
                {
                    paths.Add(item.Path);
                    descriptions.Add(new { path = item.Path, vendorId = item.VendorId, productId = item.ProductId,
                        usagePage = item.UsagePage, inputReportLength = ReportLength, outputReportLength = ReportLength });
                }
                return new { opened = true, exclusive = true, activePath = Active.Path, paths = paths,
                    inputReportLength = ReportLength, outputReportLength = ReportLength, interfaces = descriptions };
            }
            public void Close()
            {
                if (Interlocked.Exchange(ref closed, 1) != 0) return;
                try { Cancellation.Cancel(); }
                catch (Exception error) { Console.Error.WriteLine("HID cancellation cleanup: " + error.Message); }
                foreach (Interface item in Interfaces)
                {
                    // Cancel outstanding overlapped reads/writes before releasing ownership.
                    try
                    {
                        if (!item.Handle.IsClosed && !item.Handle.IsInvalid) Native.CancelIoEx(item.Handle, IntPtr.Zero);
                    }
                    catch (Exception error) { Console.Error.WriteLine("HID pending-I/O cleanup: " + error.Message); }
                }
                foreach (Interface item in Interfaces)
                {
                    try { if (item.Stream != null) item.Stream.Dispose(); }
                    catch (Exception error) { Console.Error.WriteLine("HID stream cleanup: " + error.Message); }
                    finally { item.Handle.Dispose(); }
                }
            }
        }

        private static class Native
        {
            [StructLayout(LayoutKind.Sequential)]
            public struct Attributes { public int Size; public ushort VendorID, ProductID, VersionNumber; }
            [StructLayout(LayoutKind.Sequential)]
            public struct Capabilities
            {
                public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
                [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
                public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices;
                public ushort NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices;
                public ushort NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
            }
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
            public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
                uint disposition, uint flags, IntPtr template);
            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);
            [DllImport("hid.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.U1)]
            public static extern bool HidD_GetAttributes(SafeFileHandle handle, ref Attributes attributes);
            [DllImport("hid.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.U1)]
            public static extern bool HidD_GetPreparsedData(SafeFileHandle handle, out IntPtr data);
            [DllImport("hid.dll")]
            [return: MarshalAs(UnmanagedType.U1)]
            public static extern bool HidD_FreePreparsedData(IntPtr data);
            [DllImport("hid.dll")]
            public static extern int HidP_GetCaps(IntPtr data, out Capabilities capabilities);
        }
    }
}
