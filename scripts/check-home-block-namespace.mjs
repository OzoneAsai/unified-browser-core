import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Both plugins may be enabled in the same Obsidian vault. Home tab owns
// `search-bar`; UBC must not register that language or its onload will abort
// before it registers the browser view and settings tab.
const file = ts.createSourceFile(
  "src/main.ts",
  readFileSync("src/main.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const registered = [];
function visit(node) {
  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "registerMarkdownCodeBlockProcessor"
  ) {
    assert.ok(ts.isStringLiteral(node.arguments[0]), "code block language must be a literal");
    registered.push(node.arguments[0].text);
  }
  ts.forEachChild(node, visit);
}
visit(file);
assert.deepEqual(registered, ["ubc-search-bar"]);
const registeredByHomeTab = new Set(["search-bar"]);
for (const name of registered) {
  assert.ok(!registeredByHomeTab.has(name), `${name} already belongs to Home tab`);
  registeredByHomeTab.add(name);
}
for (const path of ["README.md", "src/ui/home-search-embed.ts"]) {
  const source = readFileSync(path, "utf8");
  assert.match(source, /```ubc-search-bar/);
  assert.doesNotMatch(source, /```search-bar/);
}
console.log("Home tab and UBC code block registration namespaces coexist");
