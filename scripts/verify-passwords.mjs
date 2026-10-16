import assert from "node:assert/strict";
import esbuild from "esbuild";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
const require=createRequire(import.meta.url),root=await mkdtemp(join(tmpdir(),"ubc-password-verification-"));
const exported = async (entry, plugins=[], platformProcess=process) => {
  const result=await esbuild.build({entryPoints:[entry],bundle:true,platform:"node",format:"cjs",write:false,plugins});
  const module={exports:{}};new Function("require","module","exports","process",result.outputFiles[0].text)(require,module,module.exports,platformProcess);return module.exports;
};
try{
  // Simulate Linux's Electron secret-store provider. A desktop that silently
  // falls back to a hardcoded basic_text password must never qualify.
  let backend="basic_text";
  const linuxProcess={platform:"linux"};
  const linuxElectron={app:{isReady:()=>true},safeStorage:{
    isEncryptionAvailable:()=>true,
    getSelectedStorageBackend:()=>backend,
    encryptString:value=>Buffer.from("protected:"+value),
    decryptString:value=>value.toString().slice("protected:".length),
  }};
  const {DeviceKey:LinuxDeviceKey}=await exported("src/passwords/device-key.ts",[{name:"linux-electron-fixture",setup(build){
    build.onResolve({filter:/electron-compat$/},()=>({path:"electron-compat",namespace:"device-fixture"}));
    build.onLoad({filter:/.*/,namespace:"device-fixture"},()=>({contents:`export function compileMainProcessModule(_filename,src) {
      const m={exports:{}};globalThis.deviceVm.runInNewContext(src,{module:m,require:()=>globalThis.linuxElectronFixture,process:globalThis.linuxProcessFixture,Buffer});return m.exports;
    }`}));
  }}],linuxProcess);
  globalThis.deviceVm=vm;globalThis.linuxElectronFixture=linuxElectron;globalThis.linuxProcessFixture=linuxProcess;
  const linuxDevice=new LinuxDeviceKey();
  assert.equal(linuxDevice.available(),false,"Linux basic_text is not a protected keyring");
  backend="unknown";assert.equal(linuxDevice.available(),false);
  backend="gnome_libsecret";assert.equal(linuxDevice.available(),true);
  const testDeviceKey=Buffer.alloc(32,42);
  const wrappedLinux=linuxDevice.wrap(testDeviceKey);
  assert.equal(wrappedLinux.platform,"linux");
  assert.deepEqual(linuxDevice.unwrap(wrappedLinux),testDeviceKey);
  backend="basic_text";assert.throws(()=>linuxDevice.unwrap(wrappedLinux));
  delete globalThis.deviceVm;delete globalThis.linuxElectronFixture;delete globalThis.linuxProcessFixture;

  const {PasswordVault}=await exported("src/passwords/vault.ts",[{name:"hello-fixture",setup(build){build.onResolve({filter:/windows-hello$/},()=>({path:"hello",namespace:"fixture"}));build.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`export class WindowsHello{async request(command,args){return await globalThis.helloFixture(command,args)}dispose(){}}`}));}}]);
  const crypto=await exported("src/passwords/crypto.ts");
  const vault=new PasswordVault(join(root,"vault.json"));await vault.load();assert.equal(vault.exists,false);
  const key=await vault.setup(false);assert.equal(vault.unlocked,true);
  await Promise.all(Array.from({length:12},(_,i)=>vault.save({origin:"https://example.com",username:"user"+i,password:"dummy-secret-"+i,title:"Example",container:i%2?"work":undefined})));
  assert.equal(vault.entries().length,12,"concurrent saves must not lose entries");
  const disk=await readFile(join(root,"vault.json"),"utf8");assert.ok(!disk.includes("dummy-secret"));assert.ok(!disk.includes("user1"));
  assert.equal(vault.matches("https://example.com/path","work").length,12);
  assert.equal(vault.matches("https://example.com/path","other").length,6);
  assert.equal(vault.matches("https://different.example","work").length,0);
  vault.lock();assert.throws(()=>vault.entries());assert.throws(()=>vault.unlockRecovery("0".repeat(64)));assert.equal(vault.unlocked,false);
  vault.unlockRecovery(key);assert.equal(vault.entries().length,12);
  const first=vault.entries()[0];await vault.save({...first,password:"changed"});assert.equal(vault.entries().length,12);assert.equal(vault.entries().find(e=>e.id===first.id).password,"changed");
  await vault.remove(first.id);assert.equal(vault.entries().length,11);await vault.exclude("https://example.com/login");assert.equal(vault.excluded("https://example.com"),true);await vault.clearExcluded();assert.equal(vault.excluded("https://example.com"),false);
  const backup=await vault.exportBackup();assert.ok(!backup.includes('"hello"'));const oldKey=key;
  await assert.rejects(()=>vault.rotateRecovery(async()=>false));vault.lock();vault.unlockRecovery(oldKey);
  const newKey=await vault.rotateRecovery();vault.lock();assert.throws(()=>vault.unlockRecovery(oldKey));vault.unlockRecovery(newKey);
  const imported=new PasswordVault(join(root,"imported.json"));await imported.load();await imported.importBackup(backup,oldKey);assert.equal(imported.entries().length,11);
  const tampered=JSON.parse(backup);tampered.payload.tag="AAAAAAAAAAAAAAAAAAAAAA==";await assert.rejects(()=>imported.importBackup(JSON.stringify(tampered),oldKey));assert.equal(imported.entries().length,11,"bad import must retain current data");
  const restart=new PasswordVault(join(root,"vault.json"));await restart.load();assert.equal(restart.unlocked,false);restart.unlockRecovery(newKey);assert.equal(restart.entries().length,11);
  // Platform unlock supplements the same recovery key; it never changes the
  // encrypted payload format or leaks the vault key into the JSON backup.
  const deviceFixture = {
    platform: "darwin",
    available: () => true,
    wrap: key => ({ platform: "darwin", data: Buffer.from(key).toString("base64") }),
    unwrap: value => Buffer.from(value.data, "base64"),
  };
  const deviceFile=join(root,"device.json");
  const deviceVault=new PasswordVault(deviceFile,deviceFixture);await deviceVault.load();
  const deviceRecovery=await deviceVault.setup("device");
  await deviceVault.save({origin:"https://discord.com",username:"test-user",password:"dummy-example",title:"Discord"});
  deviceVault.lock();
  const deviceRestart=new PasswordVault(deviceFile,deviceFixture);await deviceRestart.load();
  assert.equal(deviceRestart.unlocked,true,"OS keyring must restore the vault after restart");
  assert.equal(deviceRestart.matches("https://discord.com/login","default").length,1);
  const deviceBackup=await deviceRestart.exportBackup();
  assert.ok(!deviceBackup.includes('"device"'),"portable backup must not contain a device-bound wrapping key");
  deviceRestart.lock();
  await deviceRestart.unlockDevice();
  assert.equal(deviceRestart.unlocked,true);
  await deviceRestart.disableDevice();
  deviceRestart.lock();
  const lockedRestart=new PasswordVault(deviceFile,deviceFixture);await lockedRestart.load();
  assert.equal(lockedRestart.unlocked,false,"disabling keyring must prevent automatic unlock");
  lockedRestart.unlockRecovery(deviceRecovery);
  await lockedRestart.enableDevice();
  lockedRestart.lock();
  const unavailable={...deviceFixture,available:()=>false};
  const unavailableRestart=new PasswordVault(deviceFile,unavailable);
  await unavailableRestart.load();
  assert.equal(unavailableRestart.unlocked,false,"missing OS keyring must fail closed");
  unavailableRestart.unlockRecovery(deviceRecovery);
  assert.equal(unavailableRestart.entries().length,1,"recovery must work without a keyring");
  await assert.rejects(()=>unavailableRestart.unlockDevice());
  for(const item of [deviceVault,deviceRestart,lockedRestart,unavailableRestart])item.dispose();
  const helloSecret=Buffer.alloc(32,7).toString("base64");let created=false;
  globalThis.helloFixture=async(command)=>{if(command==="create"){created=true;return{Credential:"dGVzdA==",Secret:helloSecret};}if(command==="unlock")return{Secret:helloSecret};return{Ok:true};};
  await imported.enableHello();assert.ok(created);imported.lock();await imported.unlockHello();assert.equal(imported.entries().length,11);
  const cancelled=new PasswordVault(join(root,"cancelled.json"));await cancelled.load();globalThis.helloFixture=async()=>{throw new Error("NotAllowedError");};await assert.rejects(()=>cancelled.setup(true));assert.equal(cancelled.exists,false);assert.equal(cancelled.unlocked,false);
  const helloVault=imported;helloVault.lock();let release;globalThis.helloFixture=()=>new Promise(resolve=>{release=resolve;});const pending=helloVault.unlockHello();helloVault.lock();release({Secret:helloSecret});await assert.rejects(()=>pending);assert.equal(helloVault.unlocked,false,"lock must revoke an in-flight unlock");
  assert.throws(()=>crypto.passwordOrigin("http://example.com"));assert.throws(()=>crypto.passwordOrigin("https://user:pass@example.com"));assert.equal(crypto.passwordOrigin("http://localhost:8080/path"),"http://localhost:8080");
  for(let i=0;i<50;i++)assert.equal(crypto.generatePassword().length,24);
  const corrupt=new PasswordVault(join(root,"corrupt.json"));await writeFile(join(root,"corrupt.json"),"corrupt");await corrupt.load();assert.equal(corrupt.loadFailed,true);await assert.rejects(()=>corrupt.setup(false));assert.equal(await readFile(join(root,"corrupt.json"),"utf8"),"corrupt");
  for(const item of [vault,imported,restart,cancelled,corrupt])item.dispose();
  console.log("Password vault verification passed: encryption, recovery, OS keyring restart/unlock/fallback, portable backups, concurrency, Container matching and cancellation");

  // Execute the actual isolated-world source string. A previous regression
  // silently lost regex backslashes when embedded in a JS template literal.
  const {passwordEventInstrumentation,currentPasswordSnapshotCode}=await exported("src/passwords/guest.ts",[{name:"guest-compat-fixture",setup(build){
    build.onResolve({filter:/electron-compat$/},()=>({path:"compat",namespace:"compat"}));
    build.onLoad({filter:/.*/,namespace:"compat"},()=>({contents:"export function resolveGuestWebContents(){return undefined;}"}));
  }}]);
  const captureHandlers=new Map();
  class TestInput{
    constructor(type,value){this.type=type;this.value=value;this.disabled=false;this.readOnly=false;this.offsetWidth=20;this.offsetHeight=20;this.autocomplete=type==="email"?"username":"";this.name=type;}
    getClientRects(){return [{}]}
  }
  class TestForm{
    constructor(){this.action="https://example.com/login";}
    querySelectorAll(selector){return selector==='input[type="password"]'?[this.password]:[this.username,this.password];}
  }
  const form=new TestForm();
  form.username=new TestInput("email","synthetic@example.test");
  form.password=new TestInput("password","synthetic-placeholder");
  form.username.form=form;form.password.form=form;
  const login={type:"button",textContent:"Log in",form,closest(){return this}};
  const captureDoc={addEventListener(name,callback){captureHandlers.set(name,callback)}};
  const captureContext={document:captureDoc,location:{origin:"https://example.com",href:"https://example.com/login"},HTMLInputElement:TestInput,HTMLFormElement:TestForm,URL,Date};
  captureContext.window=captureContext;captureContext.top=captureContext;
  captureDoc.querySelectorAll=selector=>form.querySelectorAll(selector);
  const filled=vm.runInNewContext(currentPasswordSnapshotCode("https://example.com"),captureContext);
  assert.equal(filled?.kind,"save");
  assert.equal(filled?.username,"synthetic@example.test");
  assert.equal(filled?.password,"synthetic-placeholder");
  assert.equal(vm.runInNewContext(currentPasswordSnapshotCode("https://other.example"),captureContext),null,"Cross-origin snapshots must fail");
  form.password.value="";
  assert.equal(vm.runInNewContext(currentPasswordSnapshotCode("https://example.com"),captureContext),null,"Empty password must never be offered");
  form.password.value="synthetic-placeholder";
  assert.equal(vm.runInNewContext(passwordEventInstrumentation.replace("__ENABLED__","true"),captureContext),null);
  captureHandlers.get("click")({isTrusted:false,target:login});
  assert.equal(captureContext.__ubcPasswords.pending,null,"scripted clicks must not save passwords");
  captureHandlers.get("click")({isTrusted:true,target:login});
  const candidate=vm.runInNewContext(passwordEventInstrumentation.replace("__ENABLED__","true"),captureContext);
  assert.equal(candidate?.kind,"save","genuine SPA login button must trigger a save candidate");
  assert.equal(candidate?.username,"synthetic@example.test");
  assert.equal(candidate?.password,"synthetic-placeholder");
  candidate.password="";
  console.log("Isolated-world password capture verified: trusted SPA login, untrusted click rejected, embedded regex preserved");

  let runtimeSource;
  globalThis.siteRuntime=source=>{runtimeSource=source;return{preload:"test",update(){},remove(){},dispose(){}};};
  const {GuestBrowserApis}=await exported("src/adapters/guest-browser-apis.ts",[{name:"electron-fixture",setup(build){build.onResolve({filter:/electron-compat$/},()=>({path:"electron",namespace:"fixture"}));build.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`export const compileMainProcessModule=(_,source)=>globalThis.siteRuntime(source);export const resolveGuestWebContents=()=>undefined;`}));}}]);
  new GuestBrowserApis().preload();
  const handlers=new Map();let preloadSource,preloadPath,promptHtml,answer=0;
  const ipcMain={on:(channel,listener)=>handlers.set(channel,listener),removeListener:channel=>handlers.delete(channel)};
  class BrowserWindow{static fromWebContents(){return undefined;}constructor(){this.webContents={id:99,setWindowOpenHandler(){},on(){}};this.events=new Map();}on(name,fn){this.events.set(name,fn);}once(name,fn){this.events.set(name,fn);}isDestroyed(){return false;}destroy(){}show(){}async loadURL(url){promptHtml=decodeURIComponent(url.split(",").slice(1).join(","));const handler=[...handlers].find(([key])=>key.endsWith("-prompt"))[1];queueMicrotask(()=>handler({sender:{id:99}},"entered value"));}}
  const native={exports:{}};
  vm.runInNewContext(runtimeSource,{module:native,require:name=>name==="electron"?{app:{getPath:()=>root},ipcMain,dialog:{showMessageBox:async()=>({response:answer})},BrowserWindow}:name==="fs"?{mkdirSync(){},writeFileSync(path,value){preloadPath=path;preloadSource=value;}}:require(name),URL,AbortController,setTimeout,clearTimeout,console});
  const runtime=native.exports,channel=[...handlers.keys()].find(key=>!key.endsWith("-prompt"));
  const frame={url:"https://example.com/login"},sender={id:1,mainFrame:frame,getLastWebPreferences:()=>({preload:preloadPath})};
  const request=async(kind,message="message",value="")=>{const event={sender,senderFrame:frame};await handlers.get(channel)(event,kind,message,value);return event.returnValue;};
  assert.equal(await request("allowed"),false);runtime.update(1,true,false);assert.equal(await request("allowed"),true);
  assert.equal(runtime.drainPassword(1,true),null);
  handlers.get(channel+"-password")({sender,senderFrame:frame},{username:"dummy",password:"not-a-real-secret"});
  frame.url="https://example.com/after-login";
  const submitted=runtime.drainPassword(1,true);assert.equal(submitted.origin,"https://example.com");assert.equal(submitted.password,"not-a-real-secret");assert.equal(runtime.drainPassword(1,true),null);
  runtime.update(1,false,false);handlers.get(channel+"-password")({sender,senderFrame:frame},{username:"dummy",password:"background"});assert.equal(runtime.drainPassword(1,true),null);runtime.update(1,true,false);
  assert.equal(await request("confirm"),true);answer=1;assert.equal(await request("confirm"),false);
  assert.equal(await request("prompt","<script>attack()</script>",'" onfocus="attack()'),"entered value");assert.ok(promptHtml.includes("&lt;script&gt;"));assert.ok(promptHtml.includes("</script>"));assert.ok(!promptHtml.includes("<script>attack()"));
  runtime.update(1,false,false);assert.equal(await request("confirm"),false);assert.equal(await request("allowed"),false);runtime.update(1,true,true);assert.equal(await request("allowed"),false);
  const spoof={returnValue:undefined,sender:{...sender,getLastWebPreferences:()=>({preload:"other"})},senderFrame:frame};await handlers.get(channel)(spoof,"allowed");assert.equal(spoof.returnValue,false);
  let passkeyCalls=0;
  const listeners=new Map();
  class FakeInput {
    constructor(type,value){this.type=type;this.value=value;this.disabled=false;this.readOnly=false;this.offsetWidth=12;this.offsetHeight=12;this.form=null;this.autocomplete=type==="email"?"username":"";this.name=type;}
    getClientRects(){return [{}];}
  }
  const loginPassword=new FakeInput("password","dummy-login-secret"),loginEmail=new FakeInput("email","dummy@example.com");
  const context={window:null,HTMLFormElement:class{},HTMLInputElement:FakeInput,
    document:{visibilityState:"visible",addEventListener(type,callback){listeners.set(type,callback);},querySelectorAll(selector){return selector==='input[type="password"]'?[loginPassword]:[loginEmail,loginPassword];}},
    CredentialsContainer:class {get(){passkeyCalls++;return Promise.resolve("ok");}create(){passkeyCalls++;return Promise.resolve("created");}},
    DOMException,AbortController,Promise,setInterval,clearInterval,process:{argv:[]}};context.window=context;
  context.require=()=>({contextBridge:{exposeInMainWorld(name,value){context[name]=value;},executeInMainWorld({func}){func();}},ipcRenderer:{
    sendSync(_channel,kind){const event={sender,senderFrame:frame};handlers.get(channel)(event,kind);return event.returnValue;},
    send(_channel,value){handlers.get(_channel)({sender,senderFrame:frame},value);}
  }});
  vm.runInNewContext(preloadSource,context);assert.equal(typeof context.prompt,"function");
  runtime.update(1,true,false);runtime.enablePasswordCapture(1,true);
  const makeButton=label=>({type:"button",textContent:label,form:null,closest(selector){return selector.includes("button")?this:null;}});
  listeners.get("click")({isTrusted:true,target:{closest:()=>makeButton("Cancel")}});
  assert.equal(runtime.drainPassword(1,true),null,"Unrelated buttons must not capture credentials");
  listeners.get("click")({isTrusted:false,target:{closest:()=>makeButton("Log In")}});
  assert.equal(runtime.drainPassword(1,true),null,"Synthetic clicks must not capture credentials");
  listeners.get("click")({isTrusted:true,target:{closest:()=>makeButton("Log In")}});
  const loginCandidate=runtime.drainPassword(1,true);
  assert.equal(loginCandidate.username,"dummy@example.com");
  assert.equal(loginCandidate.password,"dummy-login-secret","Discord-style button without a form must be captured");
  listeners.get("keydown")({isTrusted:true,key:"Enter",repeat:false,isComposing:false,target:loginPassword});
  assert.equal(runtime.drainPassword(1,true)?.password,"dummy-login-secret","Enter key should capture password submits");
  runtime.update(1,false,false);
  const credentials=new context.CredentialsContainer();await assert.rejects(()=>credentials.get({publicKey:{}}),{name:"NotAllowedError"});assert.equal(passkeyCalls,0);
  runtime.update(1,true,false);assert.equal(await credentials.get({publicKey:{}}),"ok");assert.equal(passkeyCalls,1);
  context.document.visibilityState="hidden";await assert.rejects(()=>credentials.create({publicKey:{}}),{name:"NotAllowedError"});assert.equal(passkeyCalls,1);
  context.document.visibilityState="visible";
  const abortContext={...context,CredentialsContainer:class {get(options){return new Promise((_,reject)=>options.signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true}));}create(){}}};abortContext.window=abortContext;
  abortContext.require=()=>({contextBridge:{exposeInMainWorld(name,value){abortContext[name]=value;},executeInMainWorld({func}){func();}},ipcRenderer:{sendSync(_channel,kind){const event={sender,senderFrame:frame};handlers.get(channel)(event,kind);return event.returnValue;}}});
  vm.runInNewContext(preloadSource,abortContext);const ongoing=new abortContext.CredentialsContainer().get({publicKey:{}});runtime.update(1,false,false);await assert.rejects(()=>ongoing,{name:"AbortError"});
  runtime.dispose();console.log("Guest browser API verification passed: preload syntax, background passkeys, global block, trusted sender, confirm, prompt and HTML escaping");
}finally{await rm(root,{recursive:true,force:true});delete globalThis.helloFixture;delete globalThis.siteRuntime;}
