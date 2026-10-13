import {describe, expect, it} from "vitest";
import {safeWorkspacePath, sanitizeWorkspaceState, workspaceStorageKey} from "./workspace-tabs";
describe("workspace navigation persistence", () => {
  it("namespaces both bot and thread without separator collisions", () => {expect(workspaceStorageKey("a:b", "c")).not.toBe(workspaceStorageKey("a", "b:c"));});
  it("drops credentials and unsupported schemes", () => {
    expect(sanitizeWorkspaceState({tabs: [{id:"1",kind:"browser",url:"https://user:secret@example.com"},{id:"2",kind:"browser",url:"javascript:alert(1)"}]})).toBeNull();
  });
  it("strips unrelated data and repairs missing active tab", () => {
    expect(sanitizeWorkspaceState({tabs:[{id:"a",kind:"browser",title:"test",url:"https://example.com",content:"secret"}],active:"missing"})).toEqual({tabs:[{id:"a",kind:"browser",title:"test",url:"https://example.com/"}],active:"a"});
  });
  it("bounds tabs and rejects traversal paths", () => {expect(safeWorkspacePath("../secret")).toBe(false); expect(safeWorkspacePath("a\\..\\secret")).toBe(false); expect(sanitizeWorkspaceState({tabs:Array.from({length:40},(_,i)=>({id:String(i),kind:"home"}))})?.tabs).toHaveLength(24);});
});
