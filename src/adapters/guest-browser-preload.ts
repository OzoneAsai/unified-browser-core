// Runs in the sandboxed preload world before page scripts.
export const sitePreload = String.raw`const {contextBridge,ipcRenderer} = require('electron');
if(process.argv.includes('--ubc-prompt')) {
  contextBridge.exposeInMainWorld('ubcPrompt',{finish:value=>ipcRenderer.send('__CHANNEL__-prompt',value)});
} else {
  contextBridge.exposeInMainWorld('__ubcSiteBridge',{
    allowed:()=>ipcRenderer.sendSync('__CHANNEL__','allowed'),
    dialog:(kind,message,value)=>ipcRenderer.sendSync('__CHANNEL__',kind,String(message).slice(0,4096),String(value??'').slice(0,4096))
  });
  contextBridge.executeInMainWorld({func:()=>{
    const bridge=globalThis.__ubcSiteBridge;
    window.alert=message=>{bridge.dialog('alert',message);};
    window.confirm=message=>Boolean(bridge.dialog('confirm',message));
    window.prompt=(message,value='')=>{const result=bridge.dialog('prompt',message,value);return typeof result==='string'?result:null;};
    if(!globalThis.CredentialsContainer)return;
    for(const name of ['get','create']){
      const original=CredentialsContainer.prototype[name];
      Object.defineProperty(CredentialsContainer.prototype,name,{configurable:false,writable:false,value:function(options){
        if(!options?.publicKey)return original.call(this,options);
        if(document.visibilityState!=='visible'||!bridge.allowed())return Promise.reject(new DOMException('Passkey requests are blocked in background tabs.','NotAllowedError'));
        const controller=new AbortController(),oldSignal=options.signal;
        const cancel=()=>controller.abort();
        if(oldSignal?.aborted)cancel();else oldSignal?.addEventListener('abort',cancel,{once:true});
        const timer=setInterval(()=>{if(document.visibilityState!=='visible'||!bridge.allowed())cancel();},200);
        try{return Promise.resolve(original.call(this,{...options,signal:controller.signal})).finally(()=>{clearInterval(timer);oldSignal?.removeEventListener('abort',cancel);});}
        catch(error){clearInterval(timer);oldSignal?.removeEventListener('abort',cancel);throw error;}
      }});
    }
  }});
}
if(!process.argv.includes('--ubc-prompt')) {
 const capture=target=>{
  if(!ipcRenderer.sendSync('__CHANNEL__','password-enabled'))return;
  const form=target instanceof HTMLFormElement?target:target?.form,scope=form||document;
  if(form?.action&&new URL(form.action,location.href).origin!==location.origin)return;
  const visible=f=>!f.disabled&&!f.readOnly&&f.getClientRects().length&&f.offsetWidth>0&&f.offsetHeight>0;
  const passwords=Array.from(scope.querySelectorAll('input[type="password"]')).filter(visible);
  const password=passwords.find(f=>f.autocomplete==='new-password')||passwords[0];
  if(!password?.value||password.value.length>8192)return;
  const inputs=Array.from(scope.querySelectorAll('input')).filter(visible);
  const user=inputs.find(f=>f.autocomplete==='username')||inputs.find(f=>f.type==='email')||inputs.find(f=>['text','tel'].includes(f.type)&&/user|login|email|account/i.test(f.name+' '+f.id));
  ipcRenderer.send('__CHANNEL__-password',{username:(user?.value||'').slice(0,4096),password:password.value});
 };
 document.addEventListener('submit',e=>{if(e.isTrusted)capture(e.target);},true);
 document.addEventListener('click',e=>{if(!e.isTrusted)return;const b=e.target?.closest?.('button,input[type="submit"]');if(b?.form&&b.type==='submit')capture(b.form);},true);
}
`;
