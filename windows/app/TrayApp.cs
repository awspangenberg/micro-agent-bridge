using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace MicroAgentBridge
{
    // Lives in the notification area. Owns the host process (one per user), the setup wizard and
    // the dashboard. The host itself is the Node CLI started with --ndjson --stdin-control.
    sealed class TrayApp : ApplicationContext
    {
        readonly NotifyIcon tray = new NotifyIcon();
        readonly AppSettings settings = AppSettings.Load();
        readonly SynchronizationContext ui;
        readonly Control invoker = new Control();
        WebWindow setup, dashboard;
        Streaming host, keyTest;
        string status = "stopped", message = "", transport, lastState;
        bool stopping;
        readonly HashSet<string> waiting = new HashSet<string>();
        ToolStripMenuItem statusItem, toggleItem, startupItem, alertsItem;

        public TrayApp(bool openSetup, bool background)
        {
            invoker.CreateControl();
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            BuildMenu();
            SetIcon(Icons.Tray(Color.Gray, true));
            tray.Text = "Micro Agent Bridge";
            tray.Visible = true;
            tray.DoubleClick += (_, __) => OpenDashboard();
            tray.BalloonTipClicked += (_, __) => OpenDashboard();
            Listen("Show", () => { if (settings.Onboarded) OpenDashboard(); else OpenSetup(); });
            Listen("Setup", OpenSetup);
            Listen("Quit", Quit);
            if (!settings.Onboarded || openSetup) OpenSetup();
            else
            {
                if (settings.RunHost) StartHost();
                if (!background) OpenDashboard();
            }
        }

        // Second launches signal the running instance instead of starting another host.
        void Listen(string name, Action action)
        {
            var signal = Program.Channel(name);
            new Thread(() => { while (signal.WaitOne()) ui.Post(_ => action(), null); }) { IsBackground = true }.Start();
        }

        void BuildMenu()
        {
            var menu = new ContextMenuStrip();
            statusItem = new ToolStripMenuItem("Stopped") { Enabled = false };
            toggleItem = new ToolStripMenuItem("Start", null, (_, __) => { if (HostRunning) StopHost(); else StartHost(); });
            startupItem = new ToolStripMenuItem("Start with Windows", null, (_, __) => { Startup.Enabled = !Startup.Enabled; }) { CheckOnClick = false };
            alertsItem = new ToolStripMenuItem("Alert me when a task needs me", null, (_, __) => { settings.Alerts = !settings.Alerts; settings.Save(); });
            menu.Items.AddRange(new ToolStripItem[]
            {
                statusItem, new ToolStripSeparator(),
                new ToolStripMenuItem("Open dashboard", null, (_, __) => OpenDashboard()) { Font = new Font(menu.Font, FontStyle.Bold) },
                toggleItem,
                new ToolStripSeparator(),
                startupItem, alertsItem,
                new ToolStripMenuItem("Set up again…", null, (_, __) => OpenSetup()),
                new ToolStripSeparator(),
                new ToolStripMenuItem("Quit", null, (_, __) => Quit()),
            });
            menu.Opening += (_, __) =>
            {
                startupItem.Checked = Startup.Enabled; alertsItem.Checked = settings.Alerts;
                toggleItem.Text = HostRunning ? "Stop and release the Micro" : "Start";
                toggleItem.Enabled = settings.Onboarded && keyTest?.Running != true;
            };
            tray.ContextMenuStrip = menu;
        }

        bool HostRunning => host?.Running == true;

        void SetIcon(Icon icon)
        {
            var old = tray.Icon; tray.Icon = icon;
            if (old != null && old != icon) old.Dispose();
        }

        void StartHost()
        {
            if (HostRunning || !settings.Onboarded) return;
            stopping = false; waiting.Clear(); lastState = null;
            var h = new Streaming(Cli.Host("start", "--supervise", "--wait-for-device", "--ndjson", "--stdin-control"));
            h.Line += line => ui.Post(_ => OnHostLine(line), null);
            h.Exited += code => ui.Post(_ => OnHostExit(h, code), null);
            host = h;
            SetStatus("starting", "Starting…");
            try { h.Start(); }
            catch (Exception e) { host = null; SetStatus("error", "Could not start: " + e.Message); }
        }

        Task StopHost() => Task.Run(() =>
        {
            stopping = true;
            host?.Stop();
        });

        void OnHostLine(string line)
        {
            var e = Json.Object(line);
            var type = e?.Str("type");
            switch (type)
            {
                case "running": transport = e.Str("transport"); SetStatus("running", transport == "bluetooth" ? "Running over Bluetooth" : transport == "usb" ? "Running over USB" : "Running"); break;
                case "waiting": SetStatus("waiting", e.Str("message")); break;
                case "error": case "fatal": SetStatus("error", e.Str("message")); break;
                case "state": lastState = line; Alert(e); UpdateIcon(e); break;
                case "notice": message = e.Str("message") ?? message; break;
            }
            Broadcast(new Dictionary<string, object> { ["event"] = "host", ["data"] = e });
        }

        void OnHostExit(Streaming h, int code)
        {
            if (h != host) return;
            host = null;
            if (stopping || code == 0) SetStatus("stopped", "Stopped. The Micro is released.");
            else if (status != "error") SetStatus("error", "The bridge stopped unexpectedly (exit " + code + ").");
            Broadcast(new Dictionary<string, object> { ["event"] = "host", ["data"] = new Dictionary<string, object> { ["type"] = "exited", ["code"] = code } });
        }

        void SetStatus(string next, string text)
        {
            status = next; message = text ?? "";
            statusItem.Text = next == "running" ? message : next == "waiting" ? "Waiting for the Micro" : next == "error" ? "Stopped with an error" : next == "starting" ? "Starting…" : "Stopped";
            var tip = "Micro Agent Bridge — " + statusItem.Text;
            tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
            if (next != "running") SetIcon(Icons.Tray(next == "error" ? Color.FromArgb(0xFF, 0x3B, 0x30) : Color.Gray, next != "error"));
            Broadcast(StatusMessage());
        }

        Dictionary<string, object> StatusMessage() => new Dictionary<string, object>
        {
            ["event"] = "status", ["status"] = status, ["message"] = message, ["transport"] = transport,
            ["state"] = lastState == null ? null : Json.Object(lastState),
        };

        static IEnumerable<Dictionary<string, object>> Slots(Dictionary<string, object> e)
        {
            if (!(e?.TryGetValue("snapshot", out var s) == true && s is Dictionary<string, object> snapshot && snapshot.TryGetValue("layers", out var l) && l is IEnumerable layers)) yield break;
            foreach (var layer in layers.OfType<Dictionary<string, object>>())
                if (layer.TryGetValue("slots", out var slots) && slots is IEnumerable list)
                    foreach (var slot in list.OfType<Dictionary<string, object>>()) yield return slot;
        }

        static readonly string[] NeedsYou = { "approval", "awaiting_input", "question" };
        static readonly string[] Busy = { "working", "planning", "testing", "command", "editing" };

        // The ring colour of the tray glyph mirrors the device's ambient ring.
        void UpdateIcon(Dictionary<string, object> e)
        {
            var slots = Slots(e).ToList();
            Color ring;
            if (slots.Any(s => NeedsYou.Contains(s.Str("state")))) ring = Color.FromArgb(0xFF, 0x45, 0x1F);
            else if (slots.Any(s => s.Str("state") == "error")) ring = Color.FromArgb(0xFF, 0x3B, 0x30);
            else
            {
                var providers = slots.Where(s => Busy.Contains(s.Str("state"))).Select(s => s.Str("provider")).Distinct().ToList();
                ring = providers.Count == 0 ? Color.FromArgb(0x5B, 0x8C, 0xFF) : providers.Count > 1 ? Color.White
                    : providers[0] == "claude" ? Color.FromArgb(0xFF, 0x9A, 0x1F) : Color.FromArgb(0x2F, 0x6B, 0xFF);
            }
            SetIcon(Icons.Tray(ring, false));
        }

        // One alert when a task starts waiting for approval or an answer; titles stay on this PC.
        void Alert(Dictionary<string, object> e)
        {
            var now = new HashSet<string>();
            foreach (var slot in Slots(e))
            {
                var state = slot.Str("state");
                if (!NeedsYou.Contains(state)) continue;
                var key = slot.Str("provider") + "\n" + slot.Str("title");
                now.Add(key);
                if (settings.Alerts && !waiting.Contains(key))
                {
                    var who = slot.Str("provider") == "claude" ? "Claude" : "Codex";
                    tray.ShowBalloonTip(6000, state == "question" ? who + " has a question" : who + " needs your approval",
                        slot.Str("title") ?? "A pinned task is waiting for you.", ToolTipIcon.None);
                }
            }
            waiting.Clear(); waiting.UnionWith(now);
        }

        void Broadcast(object message)
        {
            setup?.Post(message);
            dashboard?.Post(message);
        }

        void OpenSetup()
        {
            if (setup == null || setup.IsDisposed)
            {
                setup = new WebWindow("setup.html", "Set up Micro Agent Bridge", new Size(1080, 700), Handle);
                setup.FormClosed += (_, __) => { keyTest?.Stop(); setup = null; if (!settings.Onboarded && dashboard == null) Quit(); };
            }
            setup.Reveal();
        }

        void OpenDashboard(bool welcome = false)
        {
            if (!settings.Onboarded) { OpenSetup(); return; }
            if (dashboard == null || dashboard.IsDisposed)
            {
                dashboard = new WebWindow(welcome ? "dashboard.html?welcome=1" : "dashboard.html", "Micro Agent Bridge", new Size(1120, 720), Handle);
                dashboard.FormClosed += (_, __) => dashboard = null;
            }
            dashboard.Reveal();
        }

        static readonly string[] Links =
        {
            "https://github.com/awspangenberg/micro-agent-bridge",
            "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
        };

        // Requests from the local pages. Every command is fixed; pages cannot run arbitrary programs.
        async Task<object> Handle(string command, Dictionary<string, object> args)
        {
            switch (command)
            {
                case "env":
                    return new Dictionary<string, object>
                    {
                        ["version"] = Application.ProductVersion, ["onboarded"] = settings.Onboarded,
                        ["startup"] = Startup.Enabled, ["alerts"] = settings.Alerts, ["hooks"] = File.Exists(Path.Combine(Paths.State, "hook-command.json")),
                        ["codexInstalled"] = Apps.Installed("codex"), ["claudeInstalled"] = Apps.Installed("claude"),
                        ["policy"] = Apps.ExecutionPolicy(), ["hostRunning"] = HostRunning, ["stateDirectory"] = Paths.State,
                    };
                case "doctor": return (await Cli.Host(60000, "doctor")).ToMessage();
                case "status": await EnsureReleased(); return (await Cli.Host(60000, "status")).ToMessage();
                case "configure": await EnsureReleased(); return (await Cli.Host(180000, "setup-profile", "--consent")).ToMessage();
                case "restore": await EnsureReleased(); return (await Cli.Host(180000, "restore-profile")).ToMessage();
                case "running": return new Dictionary<string, object> { ["codex"] = Apps.Running("codex").Count, ["input"] = Apps.Running("input").Count };
                case "quit": return await Apps.Quit(args.Str("app") == "input" ? "input" : "codex", args.Bool("force"));
                case "bluetooth": Process.Start(new ProcessStartInfo("ms-settings:bluetooth") { UseShellExecute = true }); return true;
                case "openCodex": Process.Start(new ProcessStartInfo("codex://") { UseShellExecute = true }); return true;
                case "keyTestStart": await EnsureReleased(); StartKeyTest(); return true;
                case "keyTestStop": await Task.Run(() => keyTest?.Stop()); return true;
                case "hooks": return await Hooks(args.Bool("enable"));
                case "startup": Startup.Enabled = args.Bool("enable"); return Startup.Enabled;
                case "alerts": settings.Alerts = args.Bool("enable"); settings.Save(); return settings.Alerts;
                case "hostState": return StatusMessage();
                case "hostStart": StartHost(); return true;
                case "hostStop": await StopHost(); return true;
                case "finish":
                    settings.Onboarded = true; settings.RunHost = true; settings.Save();
                    StartHost();
                    ui.Post(_ =>
                    {
                        OpenDashboard(true); setup?.Close();
                        tray.ShowBalloonTip(6000, "Micro Agent Bridge is running", "It lives in the notification area. Right-click it to stop or start.", ToolTipIcon.None);
                    }, null);
                    return true;
                case "openSetup": ui.Post(_ => OpenSetup(), null); return true;
                case "close":
                    ui.Post(_ => { if (args.Str("window") == "setup") setup?.Close(); else dashboard?.Close(); }, null); return true;
                case "link":
                    var url = args.Str("url") ?? "";
                    if (!Links.Any(l => url == l || url.StartsWith(l + "/", StringComparison.Ordinal))) throw new InvalidOperationException("Link not allowed");
                    Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); return true;
                default: throw new InvalidOperationException("Unknown command: " + command);
            }
        }

        // Exclusive device commands need the host to release the Micro first.
        async Task EnsureReleased()
        {
            if (HostRunning) { settings.RunHost = false; await StopHost(); }
            if (keyTest?.Running == true) await Task.Run(() => keyTest.Stop());
        }

        void StartKeyTest()
        {
            var test = new Streaming(Cli.Host("test-keys", "--ndjson", "--stdin-control"));
            test.Line += line => Broadcast(new Dictionary<string, object> { ["event"] = "keytest", ["data"] = Json.Object(line) });
            test.Exited += code => Broadcast(new Dictionary<string, object> { ["event"] = "keytest-exit", ["code"] = code });
            keyTest = test;
            test.Start();
        }

        static Task<object> Hooks(bool enable) => Task.Run<object>(() =>
        {
            var result = Cli.Run(Cli.Info(Paths.Python, new[] { "-B", "-E", "-s", Paths.Hooks, enable ? "--install" : "--remove", "--state", Paths.State })).Result;
            if (result.Code != 0) throw new InvalidOperationException((result.Stderr + result.Stdout).Trim().Split('\n').Last());
            return File.Exists(Path.Combine(Paths.State, "hook-command.json"));
        });

        void Quit()
        {
            tray.Visible = false;
            keyTest?.Stop();
            stopping = true; host?.Stop();
            setup?.Close(); dashboard?.Close();
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { tray.Dispose(); invoker.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
