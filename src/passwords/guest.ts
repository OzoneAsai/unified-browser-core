import type { GuestBrowserApis } from "../adapters/guest-browser-apis";
import { resolveGuestWebContents } from "../adapters/electron-compat";
import type { WebviewElement } from "../ui/webview-types";
import { passwordOrigin } from "./crypto";

// Credentials are handled exclusively in an isolated world in the MAIN frame.
// No guest IPC endpoint, subframe traversal, main-world fallback or auto-submit.
const world = 973;
const instrumentation = `(() => {
  if (!globalThis.__ubcPasswords) {
    const state = { pending: null, sequence: 0, enabled: false };
    const fields = (target) => {
      const form = target instanceof HTMLFormElement ? target : target?.form;
      const scope = form || document;
      const visible = (field) => !field.disabled && !field.readOnly && field.getClientRects().length && field.offsetWidth > 0 && field.offsetHeight > 0;
      const passwords = Array.from(scope.querySelectorAll('input[type="password"]')).filter(visible);
      if (!passwords.length) return null;
      const password = passwords.find(f => f.autocomplete === 'new-password') || passwords[0];
      const inputs = Array.from(scope.querySelectorAll('input')).filter(visible);
      const username = inputs.find(f => f.autocomplete === 'username') || inputs.find(f => f.type === 'email') || inputs.find(f => ['text','tel'].includes(f.type) && /user|login|email|account/i.test(f.name + ' ' + f.id));
      return { password, username, form };
    };
    document.addEventListener('focusin', event => {
      if (!event.isTrusted || !(event.target instanceof HTMLInputElement) || !['password','email','text'].includes(event.target.type)) return;
      if (!fields(event.target)) return;
      if (state.pending?.kind === 'save') return;
      state.pending = { kind: 'focus', sequence: ++state.sequence, origin: location.origin, time: Date.now() };
    }, true);
    state.fields = fields;
    globalThis.__ubcPasswords = state;
  }
  const state = globalThis.__ubcPasswords, pending = state.pending; state.pending = null;
  state.enabled = __ENABLED__;
  if (!state.enabled && pending?.kind !== 'focus') return null;
  return pending && Date.now() - pending.time < 15000 ? pending : null;
})()`;
export interface PasswordGuestEvent { kind: "save" | "focus"; sequence: number; origin: string; username?: string; password?: string }
export async function readPasswordEvent(webview: WebviewElement, enabled = true, apis?: GuestBrowserApis): Promise<PasswordGuestEvent | null> {
  const captured=apis?.drainPassword(webview,enabled);if(captured)return captured;
  const wc = resolveGuestWebContents<any>(webview);
  if (!wc?.executeJavaScriptInIsolatedWorld) return null;
  return await wc.executeJavaScriptInIsolatedWorld(world, [{ code: instrumentation.replace("__ENABLED__", String(enabled)) }]) as PasswordGuestEvent | null;
}
export async function fillPassword(webview: WebviewElement, expectedUrl: string, username: string | null, password: string): Promise<boolean> {
  const origin = passwordOrigin(expectedUrl), wc = resolveGuestWebContents<any>(webview);
  if (!wc?.executeJavaScriptInIsolatedWorld || passwordOrigin(wc.getURL()) !== origin) throw new Error("Password input is unavailable on this page");
  const code = `(() => {
    if (location.origin !== ${JSON.stringify(origin)} || window !== window.top) return false;
    const fields = globalThis.__ubcPasswords?.fields?.(document.activeElement);
    if (!fields) return false;
    if (fields.form?.action && new URL(fields.form.action,location.href).origin !== location.origin) return false;
    const input = (field, value) => {
      if (!field || field.disabled || field.readOnly || !field.getClientRects().length) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,value);
      field.dispatchEvent(new Event('input',{bubbles:true})); field.dispatchEvent(new Event('change',{bubbles:true}));
    };
    if (${JSON.stringify(username)} !== null) input(fields.username, ${JSON.stringify(username)});
    input(fields.password, ${JSON.stringify(password)});
    return true;
  })()`;
  return await wc.executeJavaScriptInIsolatedWorld(world, [{ code }], true) as boolean;
}
