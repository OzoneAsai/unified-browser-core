import type { GuestBrowserApis } from "../adapters/guest-browser-apis";
import { resolveGuestWebContents } from "../adapters/electron-compat";
import type { WebviewElement } from "../ui/webview-types";
import { passwordOrigin } from "./crypto";

// Credentials are handled exclusively in an isolated world in the MAIN frame.
// No guest IPC endpoint, subframe traversal, main-world fallback or auto-submit.
const world = 973;
export const passwordEventInstrumentation = `(() => {
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
    // Electron hosts can discard <webview preload> scripts. Install the same
    // capture path inside the isolated main-frame world used for filling.
    // Only real user submits and login actions may propose saving a password.
    const capture = target => {
      if (!state.enabled || window !== window.top) return;
      const found = fields(target);
      if (!found) return;
      if (found.form?.action && new URL(found.form.action, location.href).origin !== location.origin) return;
      const password = found.password.value;
      if (!password || password.length > 8192) return;
      state.pending = {
        kind: 'save', sequence: ++state.sequence, origin: location.origin,
        username: (found.username?.value || '').slice(0, 4096),
        password, time: Date.now()
      };
    };
    document.addEventListener('submit', event => {
      if (event.isTrusted) capture(event.target);
    }, true);
    document.addEventListener('click', event => {
      if (!event.isTrusted) return;
      const button = event.target?.closest?.('button,input[type="submit"],[role="button"]');
      if (!button) return;
      const label = String(button.textContent || button.getAttribute?.('aria-label') || button.value || '').trim();
      if (button.type === 'submit' || /^(log\\s*in|sign\\s*in|log\\s*on|continue|ログイン|サインイン|次へ)(?:\\s|$)/i.test(label)) {
        capture(button.form || button);
      }
    }, true);
    document.addEventListener('keydown', event => {
      if (!event.isTrusted || event.key !== 'Enter' || event.isComposing || event.repeat) return;
      if (event.target instanceof HTMLInputElement && ['password','email','text'].includes(event.target.type)) {
        capture(event.target.form || event.target);
      }
    }, true);
    state.fields = fields;
    globalThis.__ubcPasswords = state;
  }
  const state = globalThis.__ubcPasswords, pending = state.pending; state.pending = null;
  state.enabled = __ENABLED__;
  if ((!state.enabled && pending?.kind !== 'focus') || (pending && Date.now() - pending.time >= 15000)) {
    if (pending?.password) pending.password = '';
    return null;
  }
  return pending || null;
})()`;
export interface PasswordGuestEvent { kind: "save" | "focus"; sequence: number; origin: string; username?: string; password?: string }

/** Read only the visible, already-filled login fields, on an explicit user
 * request. No credentials are retained if there is no matching form.
 * This runs in Electron's isolated world, never in website JS context. */
export function currentPasswordSnapshotCode(origin: string): string {
  return `(() => {
    if (window !== window.top || location.origin !== ${JSON.stringify(origin)}) return null;
    const visible = field => !field.disabled && !field.readOnly
      && field.getClientRects().length && field.offsetWidth > 0 && field.offsetHeight > 0;
    const candidates = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
    const passwordField = candidates.find(field => field.autocomplete === 'current-password' && field.value)
      || candidates.find(field => field.value);
    if (!passwordField || typeof passwordField.value !== 'string'
        || !passwordField.value || passwordField.value.length > 8192) return null;
    const form = passwordField.form;
    if (form?.action && new URL(form.action,location.href).origin !== location.origin) return null;
    const inputs = Array.from((form || document).querySelectorAll('input')).filter(visible);
    const usernameField = inputs.find(field => field.autocomplete === 'username')
      || inputs.find(field => field.type === 'email')
      || inputs.find(field => ['text','tel'].includes(field.type)
        && /user|login|email|account/i.test(field.name + ' ' + field.id));
    return { kind: 'save', origin: location.origin, sequence: Date.now(),
      username: String(usernameField?.value || '').slice(0, 4096),
      password: passwordField.value };
  })()`;
}

export async function readCurrentPasswordSnapshot(
  webview: WebviewElement,
  expectedUrl: string,
): Promise<PasswordGuestEvent | null> {
  const origin = passwordOrigin(expectedUrl);
  const wc = resolveGuestWebContents<any>(webview);
  if (!wc?.executeJavaScriptInIsolatedWorld || passwordOrigin(wc.getURL()) !== origin) return null;
  const result = await wc.executeJavaScriptInIsolatedWorld(world, [{
    code: currentPasswordSnapshotCode(origin),
  }]) as PasswordGuestEvent | null;
  return result?.kind === "save" && result.origin === origin && typeof result.password === "string"
    ? result : null;
}

export async function readPasswordEvent(webview: WebviewElement, enabled = true, apis?: GuestBrowserApis): Promise<PasswordGuestEvent | null> {
  const captured=apis?.drainPassword(webview,enabled);if(captured)return captured;
  const wc = resolveGuestWebContents<any>(webview);
  if (!wc?.executeJavaScriptInIsolatedWorld) return null;
  return await wc.executeJavaScriptInIsolatedWorld(world, [{ code: passwordEventInstrumentation.replace("__ENABLED__", String(enabled)) }]) as PasswordGuestEvent | null;
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
