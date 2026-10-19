using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace MicroAgentBridge
{
    // Hosts one local page. Pages are served from the install's ui\ folder through a virtual host
    // name; nothing listens on the network, and navigation anywhere else is refused.
    sealed class WebWindow : Form
    {
        public const string Origin = "https://app.micro-agent-bridge.invalid/";
        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        readonly Func<string, Dictionary<string, object>, Task<object>> handle;
        readonly Queue<string> pending = new Queue<string>();
        bool ready;

        public WebWindow(string page, string title, Size size, Func<string, Dictionary<string, object>, Task<object>> handle)
        {
            this.handle = handle;
            Text = title; ClientSize = size;
            StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.None;
            // Sizes are in 96-dpi units; scale to the monitor and keep the window on screen.
            HandleCreated += (_, __) =>
            {
                // WinForms on .NET Framework reports 96 dpi unless configured; ask Windows directly.
                float k = Math.Max(1f, GetDpiForWindow(Handle) / 96f);
                var area = Screen.FromHandle(Handle).WorkingArea;
                ClientSize = new Size(Math.Min((int)(size.Width * k), area.Width * 9 / 10), Math.Min((int)(size.Height * k), area.Height * 9 / 10));
                MinimumSize = new Size((int)(860 * k), (int)(600 * k));
                Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2);
            };
            Icon = Icons.App;
            BackColor = DarkMode ? Color.FromArgb(0x1E, 0x23, 0x28) : Color.FromArgb(0xDA, 0xDF, 0xE3);
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);
            Load += async (_, __) => await Start(page);
        }

        static bool DarkMode
        {
            get
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    return k?.GetValue("AppsUseLightTheme") is int light && light == 0;
            }
        }

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int dark = DarkMode ? 1 : 0;
            DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));   // Title bar follows the app theme.
        }

        async Task Start(string page)
        {
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData);
                await web.EnsureCoreWebView2Async(environment);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this, "Micro Agent Bridge needs the Microsoft Edge WebView2 Runtime, which is missing on this PC.\n\n" +
                    "Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and open Micro Agent Bridge again.",
                    "WebView2 Runtime required", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close(); return;
            }
            var core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("MAB_DEVTOOLS") == "1";
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.SetVirtualHostNameToFolderMapping(new Uri(Origin).Host, Paths.Ui, CoreWebView2HostResourceAccessKind.Deny);
            core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith(Origin, StringComparison.Ordinal)) e.Cancel = true; };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.WebMessageReceived += async (_, e) => await Receive(e);
            core.NavigationCompleted += (_, __) => { ready = true; while (pending.Count > 0) core.PostWebMessageAsJson(pending.Dequeue()); };
            core.Navigate(Origin + page);
        }

        async Task Receive(CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!e.Source.StartsWith(Origin, StringComparison.Ordinal)) return;
            var message = Json.Object(e.WebMessageAsJson);
            var id = message?.Str("id"); var command = message?.Str("cmd");
            if (id == null || command == null) return;
            message.TryGetValue("args", out var raw);
            var args = raw as Dictionary<string, object> ?? new Dictionary<string, object>();
            object reply;
            try { reply = new Dictionary<string, object> { ["id"] = id, ["ok"] = true, ["data"] = await handle(command, args) }; }
            catch (Exception error) { reply = new Dictionary<string, object> { ["id"] = id, ["ok"] = false, ["error"] = error.Message }; }
            Post(reply);
        }

        // Thread-safe: events arrive from CLI output threads.
        public void Post(object message)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke(new Action(() => Post(message))); } catch (InvalidOperationException) { } return; }
            var json = Json.Write(message);
            if (ready) web.CoreWebView2.PostWebMessageAsJson(json); else pending.Enqueue(json);
        }

        public void Reveal()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show(); Activate(); BringToFront();
        }
    }
}
