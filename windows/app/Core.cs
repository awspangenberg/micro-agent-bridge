using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace MicroAgentBridge
{
    // Install layout: the exe sits beside src\, ui\ and runtime\ (see packaging/build_windows.py).
    static class Paths
    {
        public static readonly string Root = Environment.GetEnvironmentVariable("MAB_ROOT") is string r && r.Length > 0
            ? Path.GetFullPath(r) : AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        public static string Node => Path.Combine(Root, "runtime", "node", "node.exe");
        public static string Python => Path.Combine(Root, "runtime", "python", "python.exe");
        public static string Control => Path.Combine(Root, "src", "standalone-control.mjs");
        public static string Hooks => Path.Combine(Root, "src", "claude_hooks.py");
        public static string Ui => Path.Combine(Root, "ui");
        public static string Exe => Process.GetCurrentProcess().MainModule.FileName;
        public static string StateBase => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Micro Agent Bridge");
        public static string State => Path.Combine(StateBase, "standalone");
        public static string WebViewData => Path.Combine(StateBase, "webview");
        public static string Settings => Path.Combine(StateBase, "app.json");
    }

    static class Json
    {
        static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        public static string Write(object value) => Serializer.Serialize(value);
        public static Dictionary<string, object> Object(string text)
        {
            try { return Serializer.DeserializeObject(text) as Dictionary<string, object>; } catch { return null; }
        }
        public static string Str(this Dictionary<string, object> o, string key) => o != null && o.TryGetValue(key, out var v) ? v as string : null;
        public static bool Bool(this Dictionary<string, object> o, string key) => o != null && o.TryGetValue(key, out var v) && v is bool b && b;
    }

    class AppSettings
    {
        public bool Onboarded { get; set; }
        public bool Alerts { get; set; } = true;
        public bool RunHost { get; set; } = true;

        public static AppSettings Load()
        {
            try { return new JavaScriptSerializer().Deserialize<AppSettings>(File.ReadAllText(Paths.Settings)) ?? new AppSettings(); }
            catch { return new AppSettings(); }
        }
        public void Save()
        {
            Directory.CreateDirectory(Paths.StateBase);
            var temp = Paths.Settings + ".tmp";
            File.WriteAllText(temp, Json.Write(this));
            if (File.Exists(Paths.Settings)) File.Replace(temp, Paths.Settings, null); else File.Move(temp, Paths.Settings);
        }
    }

    // Per-user sign-in start. The installer's optional task writes the same value.
    static class Startup
    {
        const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run", Name = "Micro Agent Bridge";
        static string Command => "\"" + Paths.Exe + "\" --background";
        public static bool Enabled
        {
            get { using (var k = Registry.CurrentUser.OpenSubKey(Key)) return k?.GetValue(Name) is string v && v.Length > 0; }
            set
            {
                using (var k = Registry.CurrentUser.CreateSubKey(Key))
                {
                    if (value) k.SetValue(Name, Command); else k.DeleteValue(Name, false);
                }
            }
        }
    }

    class CliResult
    {
        public int Code; public string Stdout = ""; public string Stderr = "";
        public object ToMessage() => new Dictionary<string, object> { ["code"] = Code, ["stdout"] = Stdout, ["stderr"] = Stderr.Trim() };
    }

    // Runs the bundled Node CLI. Arguments are passed as separate quoted values, never through a shell.
    static class Cli
    {
        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            int slashes = 0;
            foreach (var c in arg)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') sb.Append('\\', slashes * 2 + 1).Append('"');
                else sb.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            return sb.Append('\\', slashes * 2).Append('"').ToString();
        }

        public static ProcessStartInfo Info(string file, IEnumerable<string> args) => new ProcessStartInfo(file, string.Join(" ", args.Select(Quote)))
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Paths.Root,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };

        public static ProcessStartInfo Host(params string[] args) =>
            Info(Paths.Node, new[] { Paths.Control }.Concat(args).Concat(new[] { "--python", Paths.Python }));

        public static Task<CliResult> Run(ProcessStartInfo info, int timeoutMs = 120000) => Task.Run(() =>
        {
            var result = new CliResult();
            using (var p = new Process { StartInfo = info })
            {
                var output = new StringBuilder(); var error = new StringBuilder();
                p.OutputDataReceived += (_, e) => { if (e.Data != null) output.AppendLine(e.Data); };
                p.ErrorDataReceived += (_, e) => { if (e.Data != null) error.AppendLine(e.Data); };
                p.Start(); p.StandardInput.Close();
                p.BeginOutputReadLine(); p.BeginErrorReadLine();
                if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } result.Code = -1; error.AppendLine("Timed out."); }
                p.WaitForExit();
                if (result.Code == 0) result.Code = p.ExitCode;
                result.Stdout = output.ToString(); result.Stderr = error.ToString();
            }
            return result;
        });

        public static Task<CliResult> Host(int timeoutMs, params string[] args) => Run(Host(args), timeoutMs);
    }

    // A long-running CLI process that emits one JSON event per line and stops on "stop" via stdin.
    class Streaming
    {
        readonly Process process;
        public event Action<string> Line;
        public event Action<int> Exited;
        public Streaming(ProcessStartInfo info)
        {
            process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Line?.Invoke(e.Data); };
            process.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Line?.Invoke(Json.Write(new Dictionary<string, object> { ["type"] = "stderr", ["message"] = e.Data })); };
            process.Exited += (_, __) => { process.WaitForExit(); Exited?.Invoke(process.ExitCode); };
        }
        public void Start() { process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine(); }
        public bool Running { get { try { return !process.HasExited; } catch { return false; } } }
        public void Stop(int graceMs = 8000)
        {
            if (!Running) return;
            try { process.StandardInput.WriteLine("stop"); process.StandardInput.Flush(); process.StandardInput.Close(); } catch { }
            if (!process.WaitForExit(graceMs)) { try { process.Kill(); } catch { } process.WaitForExit(2000); }
        }
    }

    static class Apps
    {
        // The desktop apps register their URL schemes; that is enough to know they are installed.
        public static bool Installed(string scheme)
        {
            using (var k = Registry.ClassesRoot.OpenSubKey(scheme)) return k?.GetValue("URL Protocol") != null;
        }

        static readonly Dictionary<string, string[]> Names = new Dictionary<string, string[]>
        {
            ["codex"] = new[] { "Codex" },
            ["input"] = new[] { "Input", "WorkLouderInput", "Work Louder Input" },
        };

        public static List<Process> Running(string app) =>
            Names[app].SelectMany(Process.GetProcessesByName).Where(p => app != "codex" || Owns(p, "OpenAI.Codex")).ToList();

        static bool Owns(Process p, string package)
        {
            try { return p.MainModule.FileName.IndexOf(package, StringComparison.OrdinalIgnoreCase) >= 0; }
            catch { return true; }
        }

        // Asks the app to close its windows; force only on an explicit request.
        public static Task<int> Quit(string app, bool force) => Task.Run(() =>
        {
            foreach (var p in Running(app))
            {
                try { if (force) p.Kill(); else p.CloseMainWindow(); } catch { }
            }
            for (var i = 0; i < 40 && Running(app).Count > 0; i++) System.Threading.Thread.Sleep(250);
            return Running(app).Count;
        });

        public static string ExecutionPolicy()
        {
            // Machine/User policy scopes come from Group Policy and override -ExecutionPolicy Bypass.
            foreach (var root in new[] { Registry.LocalMachine, Registry.CurrentUser })
                using (var k = root.OpenSubKey(@"Software\Policies\Microsoft\Windows\PowerShell"))
                    if (k?.GetValue("EnableScripts") is int enabled)
                        return enabled == 0 ? "Restricted" : k.GetValue("ExecutionPolicy") as string ?? "Unrestricted";
            return null;
        }
    }
}
