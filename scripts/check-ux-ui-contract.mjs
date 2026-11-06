import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import ts from "typescript";

const css = readFileSync("styles.css", "utf8");
const screenScope = ".ubc-browser-view .ubc-surface";
for (const selector of ["h1, h2, h3, h4", "input:not([type=\"checkbox\"]):not([type=\"radio\"]), select, textarea)"]) {
  assert.ok(css.includes(screenScope) && css.includes(selector));
}
assert.match(css, /text-shadow:\s*none/);
assert.match(css, /color:\s*var\(--text-normal\)/);
assert.match(css, /background-color:\s*var\(--background-primary\)/);
assert.doesNotMatch(css, /Nier|Minimal Theme/, "fix the theme boundary, not individual themes");

const sourceText = readFileSync("src/ui/browser-view.ts", "utf8");
const ast = ts.createSourceFile("browser-view.ts", sourceText, ts.ScriptTarget.Latest, true);
let menuMethod;
const visit = (node) => {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === "onPaneMenu") menuMethod = node;
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(menuMethod?.body, "browser pane menu must exist");
const commands = [...menuMethod.getText(ast).matchAll(/\.setTitle\(t\("([^"]+)"/g)].map((m) => m[1]);
const required = [
  "Bookmark current page", "Bookmarks", "Close browser tab", "Close browser tabs to the left",
  "Close browser tabs to the right", "Close other browser tabs", "Close unpinned browser tabs",
  "Copy page URL", "Duplicate browser tab", "Fill password", "History", "Home", "Inspect page",
  "Lock password vault", "Move browser tab to new window", "Open Quick Switcher", "Passwords",
  "Reload", "Reopen closed tab", "Reopen in {v0}", "Reset site zoom", "Save password for this site",
  "Search browser tabs", "Settings", "Site permissions…", "Zoom in", "Zoom out",
];
assert.deepEqual(commands.sort(), required.sort(), "menu grouping must not drop commands");
assert.equal((menuMethod.getText(ast).match(/addHierarchicalMenuSection\(/g) ?? []).length, 3);
const settings = readFileSync("src/settings/settings-tab.ts", "utf8");
assert.match(settings, /renderSettingsSectionNavigation\(containerEl\)/);
assert.match(settings, /this\.plugin\.homeAdapter\.hasOmnisearch\(\)/);
assert.match(settings, /if \(hasOmnisearch\) homeToggle\("Show Omnisearch excerpts"/);
const nav = readFileSync("src/settings/section-navigation.ts", "utf8");
assert.match(nav, /querySelectorAll<HTMLElement>\("\.setting-item-heading"\)/);
assert.match(nav, /aria-controls/);
assert.match(nav, /scrollIntoView/);
const bookmarks = readFileSync("src/ui/browser-view.ts", "utf8");
assert.match(bookmarks, /partitionBookmarkChildren/);
assert.match(bookmarks, /bookmarksForPresentation/);
assert.match(bookmarks, /"manage"/);
assert.match(bookmarks, /t\("Filtered"\)/);
console.log("UX theme/menus/settings/navigation contracts passed");
