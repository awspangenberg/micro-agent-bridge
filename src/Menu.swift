import Cocoa
import ApplicationServices

func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e,key as CFString,&v) == .success ? v : nil
}
func element(_ v: CFTypeRef?) -> AXUIElement? {
    guard let v=v,CFGetTypeID(v)==AXUIElementGetTypeID() else{return nil}
    return unsafeBitCast(v,to:AXUIElement.self)
}
func emit(_ x:[String:Any]) {
    guard let b=try? JSONSerialization.data(withJSONObject:x,options:.sortedKeys) else{return}
    FileHandle.standardOutput.write(b+Data([10]))
}
func scan(_ root:AXUIElement, seconds:Double=0.7) -> [AXUIElement] {
    var queue=[root],result:[AXUIElement]=[],seen:[CFHashCode:[AXUIElement]]=[:],i=0
    let end=Date().addingTimeInterval(seconds)
    while i<queue.count && i<5000 && Date()<end {
        let e=queue[i];i+=1
        let hash=CFHash(e)
        if (seen[hash] ?? []).contains(where:{CFEqual($0,e)}){continue}
        seen[hash,default:[]].append(e)
        result.append(e);queue.append(contentsOf:attr(e,"AXChildren") as? [AXUIElement] ?? [])
    }
    return result
}
func label(_ e:AXUIElement)->String {
    for key in ["AXTitle","AXDescription","AXHelp"]{if let s=attr(e,key) as? String,!s.isEmpty{return s}}
    return ""
}
final class MixedMenu:NSObject,NSApplicationDelegate,NSMenuDelegate {
    let root:String
    let status=NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength)
    let menu=NSMenu()
    var task:[String:Any]?,boundWindow:AXUIElement?,boundEditor:AXUIElement?,boundWeb:AXUIElement?
    var app:NSRunningApplication?,epoch=0,armed=false,selecting=false,input=Data(),listeners:[NSObjectProtocol]=[]
    var accessibilityOwned:[pid_t:AXUIElement]=[:]
    let allControls=["FAST","Approve","Reject","SPLIT","Microphone","NEW","Dial","Joystick plan","Joystick back","Joystick forward","Joystick sidebar"]
    init(_ root:String){self.root=root;super.init()}
    func applicationDidFinishLaunching(_ notification:Notification){
        NSApp.setActivationPolicy(.accessory);status.button?.title="Micro";status.menu=menu;menu.delegate=self
        let nc=NSWorkspace.shared.notificationCenter
        listeners.append(nc.addObserver(forName:NSWorkspace.didDeactivateApplicationNotification,object:nil,queue:.main){[weak self] n in
            guard let self=self,let departed=n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else{return}
            if departed.processIdentifier==self.app?.processIdentifier{self.revoke("app-focus-changed")}
        })
        listeners.append(nc.addObserver(forName:NSWorkspace.willSleepNotification,object:nil,queue:.main){[weak self] _ in self?.revoke("sleep")})
        listeners.append(nc.addObserver(forName:NSWorkspace.sessionDidResignActiveNotification,object:nil,queue:.main){[weak self] _ in self?.revoke("screen-locked")})
        FileHandle.standardInput.readabilityHandler={ [weak self] h in
            let data=h.availableData
            DispatchQueue.main.async {
                guard let self=self else{return}
                if data.isEmpty{NSApp.terminate(nil);return}
                self.input.append(data)
                if self.input.count>65536{self.input.removeAll();self.revoke("invalid-command");return}
                while let end=self.input.firstIndex(of:10){let line=self.input.prefix(upTo:end);self.input.removeSubrange(...end)
                    if let x=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any]{self.command(x)}
                }
            }
        }
        Timer.scheduledTimer(withTimeInterval:0.15,repeats:true){[weak self] _ in
            guard let self=self else{return}
            if self.armed && !self.valid(){self.revoke("task-changed")}
        }
        emit(["event":"ready","accessibility":AXIsProcessTrusted()])
    }
    func revoke(_ reason:String,notify:Bool=true){
        let was=armed || selecting
        epoch+=1;armed=false;selecting=false;boundWindow=nil;boundEditor=nil;boundWeb=nil
        if notify && was{emit(["event":"revoked","reason":reason])}
    }
    func applicationWillTerminate(_ notification:Notification){
        for (_,root) in accessibilityOwned{if attr(root,"AXManualAccessibility") as? Bool==true{AXUIElementSetAttributeValue(root,"AXManualAccessibility" as CFString,kCFBooleanFalse)}}
    }
    func command(_ x:[String:Any]){
        switch x["command"] as? String {
        case "invalidate":revoke(x["reason"] as? String ?? "invalidated",notify:false)
        case "select":if let t=x["task"] as? [String:Any]{select(t)}
        case "action":action(x)
        default:break
        }
    }
    func window()->AXUIElement?{
        guard let app=app,NSWorkspace.shared.frontmostApplication?.processIdentifier==app.processIdentifier else{return nil}
        let root=AXUIElementCreateApplication(app.processIdentifier);AXUIElementSetMessagingTimeout(root,0.3)
        return element(attr(root,"AXFocusedWindow"))
    }
    func valid()->Bool{
        guard armed,let w=window(),let old=boundWindow,CFEqual(w,old),let editor=boundEditor,
              attr(editor,"AXRole") as? String == "AXTextArea" else{return false}
        var p:AXUIElement?=editor
        var found=false
        for _ in 0..<128 {guard let e=p else{break};if CFEqual(e,w){found=true;break};p=element(attr(e,"AXParent"))}
        guard found else{return false}
        if task?["provider"] as? String == "claude" {
            guard let web=boundWeb,let id=task?["navId"] as? String,let url=attr(web,"AXURL") else{return false}
            let value=String(describing:url)
            guard value.hasSuffix("/"+id)||value.contains("session="+id) else{return false}
        }
        return true
    }
    func copyIdentity()->String?{
        guard let app=app else{return nil}
        let paste=NSPasteboard.general,initial=paste.changeCount
        let saved=(paste.pasteboardItems ?? []).map{item -> NSPasteboardItem in
            let copy=NSPasteboardItem();for t in item.types{if let d=item.data(forType:t){copy.setData(d,forType:t)}};return copy
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier==app.processIdentifier else{return nil}
        key(37,[.maskCommand,.maskAlternate])
        let end=Date().addingTimeInterval(1.2)
        while paste.changeCount==initial && Date()<end{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
        let count=paste.changeCount
        guard count != initial,let text=paste.string(forType:.string),let url=URLComponents(string:text),url.scheme=="codex",url.host=="threads" else{return nil}
        let id=String(url.path.dropFirst())
        guard id.range(of:"^[0-9a-f-]{36}$",options:.regularExpression) != nil,paste.changeCount==count else{return nil}
        paste.clearContents();if !saved.isEmpty{_ = paste.writeObjects(saved)}
        return id
    }
    func select(_ t:[String:Any]){
        revoke("selection-start",notify:false);task=t
        let provider=t["provider"] as? String ?? "",bundle=provider=="codex" ? "com.openai.codex":"com.anthropic.claudefordesktop"
        guard let target=NSRunningApplication.runningApplications(withBundleIdentifier:bundle).first,
              let nav=t["navId"] as? String else{return}
        let native=t["nativeId"] as? String ?? ""
        if provider=="codex" && native.isEmpty{return}
        app=target
        let nativeRoot=AXUIElementCreateApplication(target.processIdentifier)
        if attr(nativeRoot,"AXManualAccessibility") as? Bool==false {
            if AXUIElementSetAttributeValue(nativeRoot,"AXManualAccessibility" as CFString,kCFBooleanTrue) == .success{accessibilityOwned[target.processIdentifier]=nativeRoot}
        }
        var route:URLComponents?
        if provider=="codex"{route=URLComponents(string:"codex://threads/"+native);route?.queryItems=[URLQueryItem(name:"hostId",value:t["hostId"] as? String)]}
        else if nav.hasPrefix("local_"){route=URLComponents(string:"claude://code/continue");route?.queryItems=[URLQueryItem(name:"session",value:nav)]}
        else{route=URLComponents(string:"claude://code/"+nav)}
        guard let url=route?.url else{return}
        NSWorkspace.shared.open(url);target.activate(options:[]);selecting=true
        let ownEpoch=epoch
        DispatchQueue.main.asyncAfter(deadline:.now()+0.6){[weak self] in self?.bind(t,ownEpoch,attempt:0)}
    }
    func bind(_ t:[String:Any],_ expected:Int,attempt:Int){
        guard epoch==expected,selecting else{return}
        guard AXIsProcessTrusted(),let w=window() else{
            report(false,"Accessibility or foreground task unavailable");return
        }
        let nodes=scan(w),provider=t["provider"] as? String ?? ""
        let editors=nodes.filter{attr($0,"AXRole") as? String == "AXTextArea" && ((attr($0,"AXDOMClassList") as? [String] ?? []).contains("ProseMirror") || provider=="claude")}
        var verified=false,web:AXUIElement?
        if provider=="codex"{verified=(t["hostVerified"] as? Bool==true) && copyIdentity()==t["nativeId"] as? String}
        else if let id=t["navId"] as? String {
            web=nodes.first{n in guard attr(n,"AXRole") as? String == "AXWebArea",let url=attr(n,"AXURL") else{return false};let value=String(describing:url);return value.hasSuffix("/"+id)||value.contains("session="+id)}
            verified=web != nil
        }
        guard epoch==expected,selecting else{return}
        if verified && editors.count==1 {
            boundWindow=w;boundEditor=editors[0];boundWeb=web;armed=true;selecting=false
            if !valid(){revoke("binding-invalid");report(false,"Task editor could not be bound");return}
            report(true,"Exact task selected")
        }else if attempt<3{
            DispatchQueue.main.asyncAfter(deadline:.now()+0.4){[weak self] in self?.bind(t,expected,attempt:attempt+1)}
        }else{selecting=false;report(false,verified ? "No unique task editor; actions disabled":"Exact task identity unavailable; actions disabled")}
    }
    func report(_ success:Bool,_ reason:String){
        var controls:[String]=[]
        if success && task?["keyboardLayer"] as? Int==3{controls=["NEW"];if button(["Allow once","Approve once","Allow this time"]) != nil{controls.append("Approve")};if button(["Reject","Deny"]) != nil{controls.append("Reject")};if button(["Back"]) != nil{controls.append("Joystick back")};if button(["Forward"]) != nil{controls.append("Joystick forward")};if button(["Hide sidebar","Show sidebar"]) != nil{controls.append("Joystick sidebar")}}
        emit(["event":"selection","armed":success,"reason":reason,"provider":task?["provider"] ?? "","nativeId":task?["nativeId"] ?? "","controls":controls,"unavailable":allControls.filter{!controls.contains($0)}])
    }
    func button(_ names:[String])->AXUIElement?{
        guard valid(),let scope=boundWeb ?? boundWindow else{return nil}
        let found=scan(scope).filter{attr($0,"AXRole") as? String=="AXButton" && names.contains(label($0)) && (attr($0,"AXEnabled") as? Bool ?? false)}
        return found.count==1 ? found[0]:nil
    }
    func key(_ code:CGKeyCode,_ flags:CGEventFlags){
        guard let app=app,NSWorkspace.shared.frontmostApplication?.processIdentifier==app.processIdentifier else{return}
        let source=CGEventSource(stateID:.privateState)
        for down in [true,false]{let event=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:down);event?.flags=flags;event?.postToPid(app.processIdentifier)}
    }
    func action(_ x:[String:Any]){
        guard x["act"] as? Int==1,x["layer"] as? Int==3,task?["keyboardLayer"] as? Int==3,valid() else{return}
        let currentEpoch=epoch,code=x["key"] as? String ?? ""
        // All unsupported controls intentionally remain inactive. No terminal shortcuts.
        guard ["ACT14","ACT15","ACT19","ACT04","ACT05","ACT20"].contains(code) else{return}
        if task?["provider"] as? String=="codex" {
            guard copyIdentity()==task?["nativeId"] as? String,epoch==currentEpoch,valid() else{revoke("identity-changed");return}
        }
        if code=="ACT19"{key(45,[.maskCommand]);revoke("new-task");return}
        let names:[String]
        switch code {
        case "ACT14":names=["Allow once","Approve once","Allow this time"]
        case "ACT15":names=["Reject","Deny"]
        case "ACT04":names=["Back"]
        case "ACT05":names=["Forward"]
        case "ACT20":names=["Hide sidebar","Show sidebar"]
        default:return
        }
        guard let control=button(names),valid(),epoch==currentEpoch else{return}
        // AXPress addresses this one displayed control, never permission mode settings.
        let result=AXUIElementPerformAction(control,kAXPressAction as CFString)
        emit(["event":"action","control":code,"performed":result == .success])
        if ["ACT04","ACT05"].contains(code){revoke("navigation");return}
        report(valid(),"Task selected")
    }
    func menuNeedsUpdate(_ menu:NSMenu){
        menu.removeAllItems()
        guard let data=try? Data(contentsOf:URL(fileURLWithPath:root+"/state.json")),let state=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{add("Starting Mixed…");return}
        let connected=(state["connection"] as? [String:Any])?["status"] as? String=="connected"
        add(connected ? "Mixed · Bluetooth connected":"Mixed · keyboard disconnected")
        add((state["sshConnected"] as? Bool==true) ? "Remote hosts connected":"One or more remote hosts unavailable")
        add("Six most recent pins · new pins replace oldest")
        menu.addItem(.separator())
        for (layer,name,slotKey,waitingKey) in [(2,"Claude","claudeSlots","claudeWaiting"),(3,"Mixed","slots","waiting")] {
        add("Layer \(layer) · \(name)")
        let slots=state[slotKey] as? [Any] ?? []
        for i in 0..<6 {
            guard i<slots.count,let t=slots[i] as? [String:Any] else{add("\(i+1). Empty");continue}
            let title=String((t["title"] as? String ?? "Task").prefix(58)),provider=(t["provider"] as? String ?? "").capitalized,host=t["host"] as? String ?? "Unknown host"
            let item=NSMenuItem(title:"\(i+1). \(provider) · \(host) · \(title)",action:#selector(selectItem(_:)),keyEquivalent:"");item.target=self;item.tag=layer*10+i
            item.toolTip="\(t["state"] as? String ?? "unknown") · \(t["nativeId"] as? String ?? "")"
            let color:NSColor
            switch t["state"] as? String {case "working":color = .systemBlue;case "awaiting_input":color = .systemOrange;case "completed":color = .systemGreen;case "idle":color = .white;case "error","disconnected":color = .systemRed;default:color = .gray}
            let image=NSImage(size:NSSize(width:10,height:10),flipped:false){r in color.setFill();NSBezierPath(ovalIn:r.insetBy(dx:1,dy:1)).fill();return true};item.image=image;menu.addItem(item)
        }
        menu.addItem(.separator())
        let waiting=state[waitingKey] as? [[String:Any]] ?? [];add("Older \(name) pins: \(waiting.count)")
        for t in waiting {add("\((t["provider"] as? String ?? "").capitalized) · \(String((t["title"] as? String ?? "Task").prefix(55)))")}
        menu.addItem(.separator())
        }
        let selection=state["selection"] as? [String:Any] ?? [:];add(selection["reason"] as? String ?? "Press a task key to enable supported actions")
        for id in selection["unresolvedPins"] as? [String] ?? []{add("Unresolved host/session: \(id)")}
        for name in state["unavailableControls"] as? [String] ?? [] {add("Unavailable: \(name)")}
        if let reason=state["attachError"] as? String{add(reason)}
        menu.addItem(.separator());let stop=NSMenuItem(title:"Stop Mixed",action:#selector(stopItem),keyEquivalent:"");stop.target=self;menu.addItem(stop)
    }
    func add(_ title:String){let item=NSMenuItem(title:title,action:nil,keyEquivalent:"");item.isEnabled=false;menu.addItem(item)}
    @objc func selectItem(_ item:NSMenuItem){emit(["event":"selectSlot","slot":item.tag%10,"layer":item.tag/10])}
    @objc func stopItem(){emit(["event":"stop"])}
}
let delegate=MixedMenu(CommandLine.arguments[1]);let app=NSApplication.shared;app.delegate=delegate;app.run()
