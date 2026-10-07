import { sitePreload } from "./guest-browser-preload";
import { compileMainProcessModule, resolveGuestWebContents } from "./electron-compat";
import type { WebviewElement } from "../ui/webview-types";

// Install before guest page scripts run. This bridge never receives vault keys.
const source = String.raw`
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const channel = 'ubc-site-api-' + crypto.randomBytes(16).toString('hex');
const states = new Map(), prompts = new Map();
const root = path.join(app.getPath('userData'), 'ubc-native'); fs.mkdirSync(root,{recursive:true});
const preloadSource = __PRELOAD_SOURCE__.replaceAll('__CHANNEL__',channel);
const preload = path.join(root,'site-api-'+crypto.createHash('sha256').update(preloadSource).digest('hex')+'.js');
fs.writeFileSync(preload,preloadSource,{mode:0o600});
const escape = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const trusted = event => {
  try { return event.sender.getLastWebPreferences().preload===preload && event.senderFrame===event.sender.mainFrame; } catch {return false;}
};
const onPrompt=(event,value)=>{const finish=prompts.get(event.sender.id);if(finish)finish(typeof value==='string'?value.slice(0,4096):null);};
ipcMain.on(channel+'-prompt',onPrompt);
const onRequest=async(event,kind,message,value)=>{
  if(!trusted(event)){event.returnValue=kind==='allowed'?false:null;return;}
  const state=states.get(event.sender.id);
  if(kind==='allowed'){event.returnValue=Boolean(state?.active&&!state.block);return;}
  if(kind==='password-enabled'){event.returnValue=Boolean(state?.active&&state.passwordEnabled);return;}
  const fallback=kind==='confirm'?false:null;
  if(!state?.active||state.busy||!['alert','confirm','prompt'].includes(kind)){event.returnValue=fallback;return;}
  const now=Date.now();state.times=state.times.filter(t=>now-t<10000);if(state.times.length>=3){event.returnValue=fallback;return;}state.times.push(now);state.busy=true;
  try{
    let origin;try{origin=new URL(event.senderFrame.url).origin;}catch{origin='Website';}
    const parent=BrowserWindow.fromWebContents(event.sender.hostWebContents||event.sender);
    message=String(message).slice(0,4096);value=String(value??'').slice(0,4096);
    if(kind!=='prompt'){
      const abort=new AbortController();state.cancel=()=>abort.abort();
      const options={title:origin+' — Browser Core',message,type:kind==='alert'?'info':'question',buttons:kind==='alert'?['OK']:['OK','Cancel'],defaultId:0,cancelId:kind==='alert'?0:1,noLink:true,signal:abort.signal};
      const answer=parent?await dialog.showMessageBox(parent,options):await dialog.showMessageBox(options);
      event.returnValue=kind==='confirm'?(!abort.signal.aborted&&answer.response===0):null;
    }else{
      event.returnValue=await new Promise(resolve=>{
        const win=new BrowserWindow({width:520,height:300,parent,modal:Boolean(parent),show:false,resizable:false,minimizable:false,maximizable:false,title:origin+' — Browser Core',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload,additionalArguments:['--ubc-prompt']}});
        let done=false;const finish=result=>{if(done)return;done=true;clearTimeout(timeout);prompts.delete(win.webContents.id);resolve(result);if(!win.isDestroyed())win.destroy();};
        const timeout=setTimeout(()=>finish(null),120000);prompts.set(win.webContents.id,finish);state.cancel=()=>finish(null);
        win.on('closed',()=>finish(null));win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
        const html='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'"><style>body{font:15px system-ui;padding:18px;background:#f5f5f5;color:#222}p{white-space:pre-wrap;overflow:auto;max-height:110px}input{box-sizing:border-box;width:100%;padding:9px}footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}button{padding:8px 20px}</style><p>'+escape(message)+'</p><form><input maxlength="4096" autofocus value="'+escape(value)+'"><footer><button type="button" id="cancel">Cancel</button><button>OK</button></footer></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();ubcPrompt.finish(document.querySelector("input").value)};document.querySelector("#cancel").onclick=()=>ubcPrompt.finish(null);document.onkeydown=e=>{if(e.key==="Escape")ubcPrompt.finish(null)};<\/script>';
        win.once('ready-to-show',()=>win.show());void win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html)).catch(()=>finish(null));
      });
    }
  }catch{event.returnValue=fallback;}finally{state.busy=false;state.cancel=undefined;}
};
ipcMain.on(channel,onRequest);
const onPassword=(event,value)=>{
 if(!trusted(event))return;const state=states.get(event.sender.id);if(!state?.active||!state.passwordEnabled)return;
 let origin;try{const url=new URL(event.senderFrame.url);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return;origin=url.origin;}catch{return;}
 if(typeof value?.password!=='string'||!value.password||value.password.length>8192||typeof value.username!=='string'||value.username.length>4096)return;
 clearTimeout(state.passwordTimeout);state.passwordTimeout=setTimeout(()=>{if(state.password)state.password.password='';state.password=undefined;},15000);
 state.password={kind:'save',sequence:Date.now(),origin,username:value.username,password:value.password,time:Date.now()};
};
ipcMain.on(channel+'-password',onPassword);
module.exports={preload,
  drainPassword(id,enabled){const state=states.get(id);if(!state)return null;state.passwordEnabled=Boolean(enabled);clearTimeout(state.passwordTimeout);const value=state.password;state.password=undefined;return enabled&&value&&Date.now()-value.time<15000?value:null;},
  update(id,active,block){let state=states.get(id);if(!state){state={times:[],busy:false};states.set(id,state);}state.active=Boolean(active);state.block=Boolean(block);if(!active)state.cancel?.();},
  remove(id){const state=states.get(id);state?.cancel?.();clearTimeout(state?.passwordTimeout);if(state?.password)state.password.password='';states.delete(id);},
  dispose(){for(const state of states.values()){state.cancel?.();clearTimeout(state.passwordTimeout);if(state.password)state.password.password='';}states.clear();ipcMain.removeListener(channel+'-password',onPassword);ipcMain.removeListener(channel,onRequest);ipcMain.removeListener(channel+'-prompt',onPrompt);}
};
`;
export class GuestBrowserApis {
  private runtime?: { preload: string; drainPassword(id:number,enabled:boolean):any; update(id:number,active:boolean,block:boolean):void; remove(id:number):void; dispose():void };
  preload(): string | undefined {
    this.runtime ??= compileMainProcessModule("ubc-site-browser-apis.cjs", source.replace("__PRELOAD_SOURCE__", JSON.stringify(sitePreload)));
    return this.runtime?.preload;
  }
  update(webview: WebviewElement, active: boolean, block: boolean): void {
    try { const wc=resolveGuestWebContents<any>(webview);if(wc)this.runtime?.update(wc.id,active,block); } catch {}
  }
  drainPassword(webview: WebviewElement,enabled:boolean):any {try {const id=webview.getWebContentsId?.();return typeof id==='number'?this.runtime?.drainPassword(id,enabled):null;}catch{return null;}}
  remove(webview: WebviewElement): void { try { const id=webview.getWebContentsId?.();if(typeof id==="number")this.runtime?.remove(id); } catch {} }
  dispose():void {this.runtime?.dispose();this.runtime=undefined;}
}

