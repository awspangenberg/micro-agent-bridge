import Cocoa
final class Setup:NSObject,NSApplicationDelegate {
 var window:NSWindow!,output:NSTextView!,consent:NSButton!,busy=false
 let root=Bundle.main.resourcePath!
 func applicationDidFinishLaunching(_ n:Notification){
  NSApp.setActivationPolicy(.regular)
  window=NSWindow(contentRect:NSRect(x:0,y:0,width:760,height:680),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false);window.title="Micro Agent Bridge";window.center()
  let stack=NSStackView();stack.orientation = .vertical;stack.spacing=10;stack.edgeInsets=NSEdgeInsets(top:16,left:16,bottom:16,right:16);stack.translatesAutoresizingMaskIntoConstraints=false
  let view=window.contentView!;view.addSubview(stack);NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:view.leadingAnchor),stack.trailingAnchor.constraint(equalTo:view.trailingAnchor),stack.topAnchor.constraint(equalTo:view.topAnchor),stack.bottomAnchor.constraint(equalTo:view.bottomAnchor)])
  stack.addArrangedSubview(NSTextField(labelWithString:"Claude layer 2 · Mixed layer 3 · Native Codex layer 1 preserved"))
  consent=NSButton(checkboxWithTitle:"Allow backed-up changes to existing layers 2 and 3",target:nil,action:nil);stack.addArrangedSubview(consent)
  for (title,command) in [("Configure","setup"),("Check compatibility","doctor"),("Start","start"),("Status","status"),("Stop","stop"),("Enable login startup","enable-login"),("Install missing Claude app","install-claude"),("Install missing Codex app","install-codex"),("Installation help","help")] {
   let b=NSButton(title:title,target:self,action:#selector(click(_:)));b.identifier=NSUserInterfaceItemIdentifier(command);stack.addArrangedSubview(b)
  }
  let scroll=NSScrollView();scroll.hasVerticalScroller=true;scroll.translatesAutoresizingMaskIntoConstraints=false;output=NSTextView();output.isEditable=false;output.isRichText=false;scroll.documentView=output;stack.addArrangedSubview(scroll);scroll.widthAnchor.constraint(equalTo:stack.widthAnchor,constant:-32).isActive=true;scroll.heightAnchor.constraint(greaterThanOrEqualToConstant:200).isActive=true
  window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true);run(["doctor"])
 }
 @objc func click(_ sender:NSButton){let command=sender.identifier!.rawValue;if command=="help"{NSWorkspace.shared.open(URL(fileURLWithPath:root+"/docs/installation.html"));return};var args=[command];if command.hasPrefix("install-"){let dialog=NSAlert();dialog.messageText="Install the missing vendor app?";dialog.informativeText="The download signature will be checked. Existing apps are preserved. Sign in directly in the vendor app afterward.";dialog.addButton(withTitle:"Install");dialog.addButton(withTitle:"Cancel");guard dialog.runModal() == .alertFirstButtonReturn else{return};args=["install-app",String(command.dropFirst(8)),"--confirm"]};if command=="setup"{args += ["--defaults","--role","desktop"];if consent.state == .on{args.append("--take-over-layers")}};run(args)}
 func run(_ args:[String]){
  guard !busy else{return};busy=true;output.string="Running \(args[0])…"
  DispatchQueue.global().async {
   let p=Process();p.executableURL=URL(fileURLWithPath:self.root+"/runtime/node/bin/node");p.arguments=[self.root+"/src/control.mjs"]+args
   let pipe=Pipe();p.standardOutput=pipe;p.standardError=pipe
   var text=""
   do {try p.run();let data=pipe.fileHandleForReading.readDataToEndOfFile();p.waitUntilExit();text=String(data:data,encoding:.utf8) ?? "";if let checks=(try? JSONSerialization.jsonObject(with:data)) as? [[String:Any]] {text=checks.map{x in ((x["ok"] as? Bool==true) ? "Ready: ":"Needs attention: ")+(x["name"] as? String ?? "")+((x["reason"] as? String).map{"\n"+$0} ?? "")}.joined(separator:"\n\n")}}catch{text=error.localizedDescription}
   DispatchQueue.main.async{self.output.string=text;self.busy=false}
  }
 }
 func applicationShouldTerminateAfterLastWindowClosed(_ app:NSApplication)->Bool{return true}
}
let delegate=Setup();NSApplication.shared.delegate=delegate;NSApplication.shared.run()
