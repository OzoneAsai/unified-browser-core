import assert from "node:assert/strict";
import { orderedTabTree } from "../src/tabs/browser-tab-tree-model";
import type { BrowserTabSnapshot } from "../src/api/browser-api";
import type { BrowserTabTreeState } from "../src/core/model";
const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] as BrowserTabSnapshot[];
const state: BrowserTabTreeState = {
  groups: [{ id: "g1", name: "Research", collapsed: false }, { id: "g2", name: "Work", collapsed: false }],
  tabToGroup: { a: "g1", c: "g1", d: "missing" },
  tabOrder: ["c", "b", "d", "a"], savedWorkspaces: {},
};
const sorted = orderedTabTree(tabs, state);
assert.deepEqual(sorted.groups.get("g1")?.map(tab => tab.id), ["c", "a"]);
assert.deepEqual(sorted.groups.get("g2")?.map(tab => tab.id), []);
assert.deepEqual(sorted.ungrouped.map(tab => tab.id), ["b", "d"]);
state.tabToGroup.b = "g2";
assert.deepEqual(orderedTabTree(tabs, state).groups.get("g2")?.map(tab => tab.id), ["b"]);
console.log("Obsidian browser tree group/order projection passed");
