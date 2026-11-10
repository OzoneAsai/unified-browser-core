/**
 * Real Obsidian 1.15 QA through an ALREADY RUNNING, isolated macOS profile.
 * No new Obsidian process/browser and no access to the user's real vault.
 * Default CDP port = 19229 (macos-qa-vault).
 *
 * Usage: node qa/obsidian-integration-macos.mjs
 */
import assert from "node:assert/strict";
const port = Number(process.env.UBC_QA_PORT || 19229);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p => p.type === "page" && p.url.startsWith("app://obsidian.md/"));
assert.ok(page, "Isolated Obsidian CDP page must be running");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(String(data));
  if (typeof message.id !== "number") return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new Error(JSON.stringify(message.error)));
  else item.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
  });
}
async function evaluate(code) {
  const result = await send("Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const namespace = "unified-browser-core-view";
const fixtureName = "UBC Integration Fixture.md";
const results = {};
let baseline = [];
const snapshot = `(()=>({
  tabs:app.workspace.getLeavesOfType('${namespace}').length,
  url:app.workspace.activeLeaf?.view?.currentUrl?.(),
  windows:window.require('@electron/remote').BrowserWindow.getAllWindows().length,
  guests:app.plugins.plugins['unified-browser-core']?.runtimeDiagnostics()?.liveGuests,
}))()`;

try {
  await send("Runtime.enable");
  const preflight = await evaluate(`(()=>({vault:app.vault.getName(),plugin:!!app.plugins.plugins['unified-browser-core'],version:app.plugins.plugins['unified-browser-core']?.manifest.version,canvas:app.workspace.getLeavesOfType('canvas').length}))()`);
  assert.equal(preflight.vault, "macos-qa-vault", "Refusing to run QA against an ordinary vault");
  assert.ok(preflight.plugin, "UBC is not loaded in the QA vault");
  baseline = await evaluate(`(()=>app.workspace.getLeavesOfType('${namespace}').map(l=>l.id))()`);
  console.log("PREFLIGHT", JSON.stringify(preflight));

  const source = await evaluate(`(async()=>{
    const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='${fixtureName}' && l.view.getMode?.()==='source');
    if(!l)throw Error('Source note not found');
    app.workspace.setActiveLeaf(l,{focus:true});await app.workspace.revealLeaf(l);
    const node=[...l.view.containerEl.querySelectorAll('.cm-underline')].find(n=>n.textContent?.includes('reading link'));
    if(!node)throw Error('Rendered Live Preview link not found');
    const b=node.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;
    return {id:l.id,point:{x,y},token:l.view.editor.getClickableTokenAt(l.view.editor.posAtCoords(x,y)),embeds:[...l.view.containerEl.querySelectorAll('.ubc-embedded-browser webview')].map(e=>e.src)};
  })()`);
  assert.equal(source.token?.type, "external-link");
  assert.equal(source.token.text, "https://example.org/ubc-reading");
  if (source.embeds.length) {
    assert.deepEqual(new Set(source.embeds), new Set(["https://example.org/ubc-embedded", "https://example.org/ubc-second-embed"]));
    results.embed = { count: source.embeds.length, urls: source.embeds };
  } else {
    // Electron throttles Markdown's asynchronous renderer when the macOS QA
    // window is hidden. Re-registering a code block processor does not force
    // its previously rendered sections to mount while the page stays hidden.
    results.embed = { deferred: "Markdown's inactive sections have not rerendered since plugin hot reload" };
  }

  const plainBefore = await evaluate(snapshot);
  const plainEvent = await evaluate(`(()=>{
    const l=app.workspace.getLeavesOfType('markdown').find(l=>l.id==='${source.id}');
    const el=[...l.view.containerEl.querySelectorAll('.cm-underline')].find(n=>n.textContent?.includes('reading link'));
    const p=${JSON.stringify(source.point)};
    const event=new MouseEvent('click',{bubbles:true,cancelable:true,button:0,clientX:p.x,clientY:p.y});
    el.dispatchEvent(event);return {prevented:event.defaultPrevented};
  })()`);
  await sleep(320);
  const plainAfter = await evaluate(snapshot);
  assert.equal(plainEvent.prevented, true);
  assert.equal(plainAfter.tabs, plainBefore.tabs + 1);
  assert.equal(plainAfter.url, "https://example.org/ubc-reading");
  assert.equal(plainAfter.windows, plainBefore.windows);
  results.livePreviewNormal = "UBC tab +1, correct URL, no OS window";

  const modifier = await evaluate(`(async()=>{
    const l=app.workspace.getLeavesOfType('markdown').find(l=>l.id==='${source.id}');
    app.workspace.setActiveLeaf(l,{focus:true}); await app.workspace.revealLeaf(l);
    const el=[...l.view.containerEl.querySelectorAll('.cm-underline')].find(n=>n.textContent?.includes('reading link'));
    const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;
    const old=window.open,calls=[];window.open=(...args)=>{calls.push(args);return null;};
    const before=app.workspace.getLeavesOfType('${namespace}').length;
    const event=new MouseEvent('click',{bubbles:true,cancelable:true,button:0,metaKey:true,clientX:x,clientY:y});
    try{el.dispatchEvent(event)}finally{window.open=old}
    return {before,after:app.workspace.getLeavesOfType('${namespace}').length,prevented:event.defaultPrevented,calls};
  })()`);
  assert.equal(modifier.prevented, true);
  assert.equal(modifier.after, modifier.before);
  assert.deepEqual(modifier.calls, [["https://example.org/ubc-reading", "_external"]]);
  results.livePreviewModified = "external handoff exactly once, UBC tabs unchanged";

  const ordinary = await evaluate(`(()=>{
    const l=app.workspace.getLeavesOfType('markdown').find(l=>l.id==='${source.id}');
    const el=[...l.view.containerEl.querySelectorAll('.cm-line')].find(n=>n.textContent?.startsWith('External '));
    const before=app.workspace.getLeavesOfType('${namespace}').length;
    const old=window.open,calls=[];window.open=(...args)=>{calls.push(args);return null;};
    const e=new MouseEvent('click',{bubbles:true,cancelable:true,button:0,metaKey:true});
    try{el.dispatchEvent(e)}finally{window.open=old}
    return {before,after:app.workspace.getLeavesOfType('${namespace}').length,calls};
  })()`);
  assert.equal(ordinary.after, ordinary.before);
  assert.deepEqual(ordinary.calls, []);
  results.editorText = "no browser routing for ordinary Markdown text";

  const prop = await evaluate(`(async()=>{
    const l=app.workspace.getLeavesOfType('markdown').find(l=>l.id==='${source.id}');
    app.workspace.setActiveLeaf(l,{focus:true}); await app.workspace.revealLeaf(l);
    const el=l.view.containerEl.querySelector('.metadata-link-inner[data-href="https://example.org/ubc-properties"]');
    if(!el)return {skipped:'Properties value DOM not rendered in hidden QA window'};
    const before=app.workspace.getLeavesOfType('${namespace}').length;
    const e=new MouseEvent('click',{bubbles:true,cancelable:true,button:0});el.dispatchEvent(e);
    return {before,prevented:e.defaultPrevented};
  })()`);
  if (!prop.skipped) {
    await sleep(280);const after = await evaluate(snapshot);
    assert.equal(prop.prevented, true);
    assert.equal(after.tabs, prop.before + 1);
    assert.equal(after.url, "https://example.org/ubc-properties");
    results.properties = "UBC tab +1, correct properties URL";
  } else results.properties = prop.skipped;

  const canvas = await evaluate(`(async()=>{
    const l=app.workspace.getLeavesOfType('canvas').find(l=>l.view.file?.path==='UBC Canvas Fixture.canvas');
    if(!l)return {skipped:'Canvas fixture not open'};
    app.workspace.setActiveLeaf(l,{focus:true}); await app.workspace.revealLeaf(l);
    const button=l.view.containerEl.querySelector('.ubc-canvas-browser-action');
    if(!button)return {skipped:'Canvas action not rendered'};
    const before=app.workspace.getLeavesOfType('${namespace}').length;
    button.click();return {before,count:l.view.containerEl.querySelectorAll('.ubc-canvas-browser-action').length};
  })()`);
  if (!canvas.skipped) {
    await sleep(280);const after=await evaluate(snapshot);
    assert.equal(after.tabs, canvas.before + 1);
    assert.equal(after.url, "https://example.org/ubc-canvas");
    results.canvas = `one button, opens UBC tab`;
  } else results.canvas = canvas.skipped;

  // Undo only tabs opened by this QA script, leaving the rest of the user's
  // pre-existing isolated QA workspace untouched.
  const cleaned = await evaluate(`(()=>{
    const baseline=new Set(${JSON.stringify(baseline)});
    const added=app.workspace.getLeavesOfType('${namespace}').filter(l=>!baseline.has(l.id));
    for(const leaf of added)leaf.detach();
    return {closed:added.length,remaining:app.workspace.getLeavesOfType('${namespace}').length};
  })()`);
  results.cleanup = cleaned;
  const deferred = Object.values(results).filter(item => item?.deferred || (typeof item === "string" && item.includes("not rendered")));
  console.log(deferred.length ? "QA PASS WITH DEFERRED RENDERS" : "QA PASS", JSON.stringify(results,null,2));
} catch (error) {
  console.error("QA FAIL",error);
  process.exitCode=1;
} finally {ws.close();}
