// Isolated renderer check: real UpdateBanner, synthetic preload, disposable
// Electron profile. Never loads main.mjs, an updater feed, or the user's data.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const scratch = mkdtempSync(join(tmpdir(), "bos-update-ui-"));
try {
  const bundle = await build({
    stdin: {contents: `import React from "react"; import {createRoot} from "react-dom/client";
      import {UpdateBanner} from "./src/components/UpdateBanner.tsx";
      let listener; window.installs=0; window.checks=0;
      window.ogb={updater:{onState(cb){listener=cb; cb({status:"idle"}); return ()=>{};},
        install:async()=>{window.installs++;}, check:async()=>{window.checks++;}}};
      window.changeUpdate=state=>listener({automaticUpdates:true,...state});
      createRoot(document.getElementById("root")).render(<UpdateBanner/>);`,
      resolveDir: process.cwd(), loader: "tsx"},
    alias: {"@": resolve("src")}, bundle: true, write: false, format: "iife", jsx: "automatic",
    define: {"process.env.NODE_ENV": '"production"'},
  });
  writeFileSync(join(scratch, "renderer.js"), bundle.outputFiles[0].text);
  writeFileSync(join(scratch, "index.html"), `<!doctype html><html><head><style>
    body{margin:0;background:#171717;color:#eee;font:16px system-ui}dialog{position:fixed;inset:0;margin:0;width:100vw;height:100vh;max-width:none;max-height:none;border:0;background:#171717;color:#eee;display:flex;align-items:center;justify-content:center}dialog>div{width:340px;text-align:center}svg{width:28px;height:28px}button,a{color:inherit}button{background:#333;border:1px solid #555;border-radius:16px;padding:10px}a{color:#aaa}p{line-height:1.5;color:#bbb}
    </style></head><body><button id="background">background control</button><div id="root"></div><script src="renderer.js"></script></body></html>`);
  writeFileSync(join(scratch, "main.cjs"), `const {app,BrowserWindow}=require("electron");
    const fs=require("node:fs"); app.setPath("userData",${JSON.stringify(join(scratch,"profile"))});
    app.whenReady().then(async()=>{let win;try{
      win=new BrowserWindow({show:false,width:780,height:540,webPreferences:{sandbox:true,contextIsolation:true}});
      await win.loadFile(${JSON.stringify(join(scratch,"index.html"))});
      const run=s=>win.webContents.executeJavaScript(s); const tick=()=>new Promise(r=>setTimeout(r,60));
      await tick(); let checks=0;
      const check=async(s)=>{if(!await run(s))throw Error(s); checks++;};
      for(const status of ["idle","checking","downloading","preparing"]){await run('window.changeUpdate('+JSON.stringify({status})+')');await tick();await check('document.getElementById("root").textContent === ""');}
      await run('window.changeUpdate({status:"downloaded",version:"2.1.3"})');await tick();
      await check('document.getElementById("root").textContent.trim() === "Restart to finish"');
      await run('document.querySelector("#root button").click()');await check('window.installs === 1');
      await run('window.changeUpdate({status:"downloading",required:true,minimumVersion:"2.1.3",percent:42})');await tick();
      await check('document.querySelector("dialog").matches(":modal")');
      await run('document.getElementById("background").focus()');await check('document.activeElement.id !== "background"');
      await check('document.querySelector("dialog").textContent.includes("Updating bos")');
      const shot=await win.webContents.capturePage();fs.writeFileSync(${JSON.stringify(join(scratch,"screen.png"))},shot.toPNG());
      await run('window.changeUpdate({status:"error",required:true,retryable:false,message:"No published update meets the required version. Download the latest installer."})');await tick();
      await check('!document.querySelector("dialog")');
      await check('document.getElementById("root").textContent.includes("No published update")');
      await check('[...document.querySelectorAll("#root button")].some(b => b.textContent.trim() === "Dismiss")');
      fs.writeFileSync(${JSON.stringify(join(scratch,"result.json"))},JSON.stringify({checks}));
      win.destroy();app.exit(0);
    }catch(e){console.error(e);win?.destroy();app.exit(1);}});`);
  const child = spawnSync(require("electron"), [join(scratch, "main.cjs")], {
    env: {...process.env, HOME: scratch, ELECTRON_RUN_AS_NODE: ""}, encoding: "utf8", timeout: 90_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(readFileSync(join(scratch, "result.json"), "utf8"));
  // Keep the screenshot outside the disposable profile as review evidence.
  const evidence = join(tmpdir(), "bos213-update-screen.png");
  writeFileSync(evidence, readFileSync(join(scratch, "screen.png")));
  console.log(JSON.stringify({...result, screenshot:evidence}));
} finally { rmSync(scratch, {recursive:true, force:true}); }
