# Third-party notices

Micro Agent Bridge is an independent project and is not affiliated with OpenAI,
Anthropic, or Work Louder. Their product names identify compatible products.
No vendor desktop application, authentication material, or extracted application
code is included in this project's installers.

Prebuilt packages include Node.js (MIT and the notices in its distribution).
The macOS application additionally includes CPython via Python Build Standalone
(PSF license and component licenses retained in that distribution). Runtime
versions, download locations, and SHA-256 digests are pinned in
`packaging/runtimes.json`. Those runtimes retain their bundled licenses.

Ubuntu GUI dependencies (GTK, PyGObject, AT-SPI, AppIndicator) and Python are
provided separately by Ubuntu's package manager under their respective licenses.
Optional vendor installations are downloaded separately from vendor sources.

The Windows source workflow installs `node-hid` 3.4.0 for device enumeration.
Its distribution includes `LICENSE-bsd.txt` and HIDAPI's license files. The npm
dependencies `node-addon-api` and `pkg-prebuilds` include their MIT licenses.
Keep those notices with any redistributed dependencies. The Windows exclusive
transport is implemented here; no extracted vendor SDK code is bundled.

The Windows installer also bundles CPython via Python Build Standalone (PSF
license and component licenses retained in its `runtime\python` folder) and the
Microsoft Edge WebView2 SDK 1.0.2903.40 (`Microsoft.Web.WebView2.Core.dll`,
`Microsoft.Web.WebView2.WinForms.dll`, `WebView2Loader.dll`), redistributed
under its BSD-style license from the `Microsoft.Web.WebView2` NuGet package. The
WebView2 Runtime itself is part of Windows and is not bundled.
