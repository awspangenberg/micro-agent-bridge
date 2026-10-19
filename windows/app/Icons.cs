using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;

namespace MicroAgentBridge
{
    // Tray glyph: the Micro seen from above, its light ring tinted by the bridge's state.
    static class Icons
    {
        public static readonly Icon App = LoadApp();
        static Icon LoadApp()
        {
            try { return Icon.ExtractAssociatedIcon(Paths.Exe); } catch { return SystemIcons.Application; }
        }

        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

        public static Icon Tray(Color ring, bool dim)
        {
            int size = Math.Max(16, System.Windows.Forms.SystemInformation.SmallIconSize.Width);
            using (var bitmap = new Bitmap(size, size))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    float s = size / 16f;
                    var body = new RectangleF(1.5f * s, 2.5f * s, 13f * s, 11f * s);
                    using (var path = Rounded(body, 3f * s))
                    {
                        using (var fill = new SolidBrush(Color.FromArgb(0x2A, 0x31, 0x38))) g.FillPath(fill, path);
                        using (var pen = new Pen(dim ? Color.FromArgb(0x7A, 0x84, 0x8E) : ring, 1.6f * s)) g.DrawPath(pen, path);
                    }
                    using (var key = new SolidBrush(Color.FromArgb(0xC9, 0xD1, 0xD8)))
                        for (int row = 0; row < 2; row++)
                            for (int col = 0; col < 3; col++)
                                g.FillRectangle(key, (4.2f + col * 2.9f) * s, (5.4f + row * 2.9f) * s, 1.9f * s, 1.9f * s);
                }
                var handle = bitmap.GetHicon();
                try { return (Icon)Icon.FromHandle(handle).Clone(); } finally { DestroyIcon(handle); }
            }
        }

        static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var p = new GraphicsPath(); float d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure(); return p;
        }
    }
}
