import { Modal, Notice, type App } from "obsidian";
import { readFile, writeFile } from "node:fs/promises";
import { resolveElectronRemote } from "../adapters/electron-compat";
import { t } from "../i18n";
import { confirmAction } from "../ui/confirm-modal";
import type { PasswordEntry, PasswordVault } from "./vault";
import { generatePassword } from "./crypto";

function button(parent: HTMLElement, label: string, action: () => void | Promise<void>, primary = false): HTMLButtonElement {
  const el = parent.createEl("button", { text: t(label), cls: primary ? "mod-cta" : "", attr: { type: "button" } });
  el.addEventListener("click", async () => { el.disabled = true; try { await action(); } catch { new Notice(t("Password operation failed. Check your key, Windows Hello, and file access.")); } finally { el.disabled = false; } });
  return el;
}
function field(parent: HTMLElement, label: string, value = "", type = "text"): HTMLInputElement {
  const row = parent.createEl("label", { cls: "ubc-password-field" }); row.createSpan({ text: t(label) });
  const input = row.createEl("input", { attr: { type, autocomplete: "off", spellcheck: "false" } }); input.value = value; return input;
}
class SensitiveModal extends Modal {
  private disposeLock?: () => void;
  constructor(app: App, protected vault: PasswordVault, private requireUnlocked = true) { super(app); }
  watch(): void { const epoch=this.vault.lockEpoch;this.disposeLock = this.vault.subscribe(() => { if(this.vault.lockEpoch!==epoch || this.requireUnlocked && !this.vault.unlocked) this.close(); }); }
  onClose(): void { this.disposeLock?.(); for(const input of this.contentEl.querySelectorAll<HTMLInputElement>("input")) input.value=""; this.contentEl.empty(); }
}
export function showRecoveryKey(app: App, vault: PasswordVault, key: string): Promise<boolean> {
  return new Promise(resolve => {
    let acknowledged = false;
    class RecoveryModal extends SensitiveModal {
      onOpen(): void {
        this.watch(); this.titleEl.setText(t("Save your recovery key"));
        this.contentEl.createEl("p",{text:t("Store this key outside your vault. It unlocks encrypted backups when Windows Hello or this PC is unavailable.")});
        const value=field(this.contentEl,"Recovery key",key); value.readOnly=true;
        const check=this.contentEl.createEl("label",{cls:"ubc-password-field"}); const saved=check.createEl("input",{attr:{type:"checkbox"}}); check.createSpan({text:t("I saved the recovery key securely")});
        const done=button(this.contentEl,"Done",()=>{acknowledged=true;this.close();},true); done.disabled=true; saved.addEventListener("change",()=>{done.disabled=!saved.checked;});
        value.addEventListener("focus",()=>value.select());
      }
      onClose():void {key="";super.onClose();resolve(acknowledged);}
    }
    new RecoveryModal(app,vault,false).open();
  });
}
export function unlockVault(app: App, vault: PasswordVault): Promise<boolean> {
  if(vault.unlocked) return Promise.resolve(true);
  return new Promise(resolve=>{
    class UnlockModal extends SensitiveModal {
      onOpen(): void {
        this.watch();
        this.titleEl.setText(t("Unlock password vault"));
        this.contentEl.createEl("p",{text:t("Choose Windows Hello or enter your recovery key. Failed authentication never falls back automatically.")});
        if(vault.usesHello) button(this.contentEl,"Unlock with Windows Hello",async()=>{await vault.unlockHello();this.close();},true);
        const input=field(this.contentEl,"Recovery key","","password");
        button(this.contentEl,"Unlock with recovery key",()=>{vault.unlockRecovery(input.value);input.value="";this.close();});
      }
      onClose():void {super.onClose();resolve(vault.unlocked);}
    }
    new UnlockModal(app,vault,false).open();
  });
}
export function editPassword(app: App,vault: PasswordVault,initial: Partial<PasswordEntry>={}): Promise<void> {
  return new Promise(resolve=>{
    class Editor extends SensitiveModal {
      onOpen():void {
        this.watch();this.titleEl.setText(t(initial.id?"Edit password":"Save password"));
        const origin=field(this.contentEl,"Site origin",initial.origin??"https://");
        const title=field(this.contentEl,"Name",initial.title??""); const user=field(this.contentEl,"Username",initial.username??"");
        const password=field(this.contentEl,"Password",initial.password??"","password");
        const actions=this.contentEl.createDiv({cls:"ubc-password-actions"});
        button(actions,"Generate password",()=>{password.value=generatePassword();});
        button(actions,"Show / hide",()=>{password.type=password.type==="password"?"text":"password";});
        const container=field(this.contentEl,"Container ID (empty for all)",initial.container??"");
        button(this.contentEl,"Save",async()=>{await vault.save({id:initial.id,origin:origin.value,username:user.value,password:password.value,title:title.value,container:container.value.trim()||undefined});this.close();},true);
      }
      onClose():void {initial.password="";super.onClose();resolve();}
    }
    new Editor(app,vault).open();
  });
}
export function renderPasswordPage(parent: HTMLElement,app: App,vault: PasswordVault):()=>void {
  let query="", disposed=false;
  const render=()=>{
    if(disposed)return;parent.empty(); const page=parent.createDiv({cls:"ubc-surface ubc-passwords"});
    page.createEl("h1",{text:t("Passwords")});page.createEl("p",{text:t("An encrypted vault inside Browser Core. Fill only after choosing an account; forms are never submitted automatically.")});
    const actions=page.createDiv({cls:"ubc-password-actions"});
    if(!vault.exists){
      page.createEl("h2",{text:t("Create your password vault")});
      page.createEl("p",{text:t("Windows Hello setup asks for authentication twice to verify that the key can be used again. A recovery key is issued for backups and other devices.")});
      if(process.platform==="win32")button(actions,"Set up with Windows Hello",async()=>{await vault.setup(true,key=>showRecoveryKey(app,vault,key));},true);
      button(actions,"Set up with recovery key",async()=>{await vault.setup(false,key=>showRecoveryKey(app,vault,key));});
    }else if(!vault.unlocked){
      page.createEl("h2",{text:t("Password vault is locked")});
      if(vault.loadFailed)page.createEl("p",{text:t("The password vault file could not be read. It has not been overwritten. Restore an encrypted backup.")});
      else button(actions,"Unlock password vault",()=>unlockVault(app,vault).then(()=>{}),true);
    }else{
      button(actions,"Lock",()=>vault.lock());button(actions,"New password",()=>editPassword(app,vault));
      button(actions,"Export encrypted backup",()=>exportBackup(vault));
      button(actions,"New recovery key",async()=>{if(await confirmAction(app,t("New recovery key"),t("Keep old recovery keys for old backups. The new key applies to the current vault and future backups."),t("Continue")))await vault.rotateRecovery(key=>showRecoveryKey(app,vault,key));});
      if(process.platform==="win32")button(actions,vault.usesHello?"Replace Windows Hello key":"Enable Windows Hello",()=>vault.enableHello());
      if(vault.usesHello)button(actions,"Disable Windows Hello",async()=>{if(await confirmAction(app,t("Disable Windows Hello"),t("Make sure you have your recovery key. Future unlocks will require it."),t("Continue")))await vault.disableHello();});
      button(actions,"Allow save suggestions on all sites",()=>vault.clearExcluded());
      const idle=field(page,"Lock after inactivity (minutes)",String(vault.idleMinutes),"number");idle.min="1";idle.max="60";
      idle.addEventListener("change",()=>{void vault.setIdleMinutes(Number(idle.value)).catch(()=>new Notice(t("Enter a value from 1 to 60.")));});
      const search=field(page,"Search passwords",query,"search"); const list=page.createDiv({cls:"ubc-password-list"});
      const show=()=>{
        list.empty();const entries=vault.entries().filter(entry=>[entry.origin,entry.username,entry.title].join(" ").toLowerCase().includes(query.toLowerCase()));
        if(!entries.length)list.createEl("p",{text:t("No saved passwords")});
        for(const entry of entries){const row=list.createEl("article",{cls:"ubc-password-card"});row.createEl("strong",{text:entry.title||new URL(entry.origin).hostname});row.createDiv({text:entry.origin});row.createDiv({text:entry.username||t("No username")});if(entry.container)row.createDiv({text:entry.container});
          const controls=row.createDiv({cls:"ubc-password-actions"});button(controls,"Edit",()=>editPassword(app,vault,vault.entries().find(item=>item.id===entry.id)));
          button(controls,"Delete",async()=>{if(await confirmAction(app,t("Delete password"),entry.origin+"\n"+entry.username,t("Delete")))await vault.remove(entry.id);});
          // List DOM never contains a saved password; reveal only in the editor.
          entry.password="";
        }
      };
      search.addEventListener("input",()=>{query=search.value;show();});show();
    }
    button(actions,"Import encrypted backup",()=>importBackup(app,vault));
    page.createEl("p",{cls:"ubc-password-note",text:t("Windows Hello protects local unlock. Recovery keys unlock backups. Other Obsidian plugins share this process; unlocked credentials cannot be isolated from a compromised host.")});
  };
  const off=vault.subscribe(render);render();return()=>{disposed=true;off();parent.empty();};
}
async function exportBackup(vault: PasswordVault):Promise<void>{
  const remote=resolveElectronRemote();const result=await remote?.dialog?.showSaveDialog(remote.getCurrentWindow(),{title:t("Export encrypted backup"),defaultPath:"ubc-passwords.encrypted.json",filters:[{name:"Encrypted UBC vault",extensions:["json"]}]});
  if(!result?.canceled&&result?.filePath)await writeFile(result.filePath,await vault.exportBackup(),{mode:0o600});
}
async function importBackup(app: App,vault: PasswordVault):Promise<void>{
  const remote=resolveElectronRemote();const result=await remote?.dialog?.showOpenDialog(remote.getCurrentWindow(),{title:t("Import encrypted backup"),properties:["openFile"],filters:[{name:"Encrypted UBC vault",extensions:["json"]}]});
  if(result?.canceled||!result?.filePaths?.[0])return;
  const text=await readFile(result.filePaths[0],"utf8");
  class Importer extends SensitiveModal{
    onOpen():void{this.watch();this.titleEl.setText(t("Import encrypted backup"));this.contentEl.createEl("p",{text:t("Import replaces the current password vault. Export a backup first. Enter the recovery key belonging to the imported backup.")});const key=field(this.contentEl,"Recovery key","","password");
      button(this.contentEl,"Import",async()=>{if(vault.exists&&!await confirmAction(app,t("Replace password vault"),t("Replace the current password vault with this backup?"),t("Import")))return;await vault.importBackup(text,key.value);key.value="";this.close();},true);
    }
  }
  new Importer(app,vault,false).open();
}

export function passwordPopover(anchor: HTMLElement,title:string,build:(panel:HTMLElement,close:()=>void)=>void,onClose?:()=>void):()=>void{
  const doc=anchor.ownerDocument,win=doc.defaultView??window;
  const panel=doc.body.createDiv({cls:"ubc-password-popover",attr:{role:"dialog","aria-label":t(title)}});panel.createEl("strong",{text:t(title)});
  const rect=anchor.getBoundingClientRect();panel.style.top=Math.min(rect.bottom+8,win.innerHeight-160)+"px";panel.style.right=Math.max(8,win.innerWidth-rect.right)+"px";
  let closed=false;const close=()=>{if(closed)return;closed=true;for(const input of panel.querySelectorAll<HTMLInputElement>("input"))input.value="";panel.remove();doc.removeEventListener("pointerdown",outside,true);doc.removeEventListener("keydown",escape,true);win.removeEventListener("resize",close);onClose?.();};
  const outside=(event:PointerEvent)=>{if(!panel.contains(event.target as Node)&&!anchor.contains(event.target as Node))close();};
  const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")close();};
  doc.addEventListener("pointerdown",outside,true);doc.addEventListener("keydown",escape,true);win.addEventListener("resize",close);build(panel,close);return close;
}
export { button as passwordButton };
