using System;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace MicroAgentBridge
{
    static class Program
    {
        // --setup opens onboarding; --background starts in the notification area only (sign-in start).
        [STAThread]
        static int Main(string[] args)
        {
            bool openSetup = args.Contains("--setup"), background = args.Contains("--background"), quit = args.Contains("--quit");
            using (var mutex = new Mutex(true, @"Local\MicroAgentBridge.App", out bool first))
            {
                // --quit asks a running instance to stop the host and exit (used by the installer).
                if (quit) { if (!first) using (var signal = Channel("Quit")) signal.Set(); return 0; }
                if (!first)
                {
                    using (var signal = Channel(openSetup ? "Setup" : "Show")) if (!background) signal.Set();
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp(openSetup, background));
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        public static EventWaitHandle Channel(string name) =>
            new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\MicroAgentBridge." + name);
    }
}
