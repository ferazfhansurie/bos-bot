// Syntax-aware env rewriting; string fixtures and generated scripts stay strings.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const { prefixAliases } = JSON.parse(readFileSync(resolve(root, "electron/branding-compat.json"), "utf8"));
const prefixes = prefixAliases.flat();
const brandedName = name => prefixes.some(prefix => name.startsWith(prefix));
let count = 0;
for (const path of execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0")) {
  if (!/\.(ts|mjs|cjs)$/.test(path) || /branding-env|rename-env/.test(path)) continue;
  const file = resolve(root, path);
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  if (!prefixes.some(prefix => text.includes(prefix))) continue;
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const edits = new Map();
  const names = new Set();
  const tests = /\.test\.|\.node-test\./.test(path);
  function add(node, replacement, name) {
    edits.set(node.getStart(ast), [node.end, replacement]);
    names.add(name);
  }
  function isWrite(node) {
    const parent = node.parent;
    if (!parent) return false;
    return ts.isDeleteExpression(parent) ||
      (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment);
  }
  function normalized(node, value) {
    if (value !== "env" && value !== "environment") return false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent) && parent.body) {
        const body = parent.body.getText(ast);
        return body.includes(value + " = compatEnvironment(");
      }
    }
    return false;
  }
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.getText(ast) === "process.env") add(node, "compatEnv", "compatEnv");
    if (!tests && !isWrite(node) && ((ts.isPropertyAccessExpression(node) && brandedName(node.name.text)) || (ts.isElementAccessExpression(node) && (!ts.isStringLiteral(node.argumentExpression) || brandedName(node.argumentExpression.text))))) {
      const object = node.expression;
      const value = object.getText(ast);
      if (/^(?:env|environment|input\.environment|options\.env)$/.test(value) && !normalized(node, value)) add(object, `compatEnvironment(${value})`, "compatEnvironment");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!edits.size) continue;
  if (check) { process.stderr.write(path + ": environment aliases not applied\n"); count++; continue; }
  for (const [start, [end, replacement]] of Array.from(edits).sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  let rel = relative(dirname(file), resolve(root, "electron/branding-env.cjs")).replaceAll("\\", "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  const imported = new Set(Array.from(text.matchAll(/(?:import|const)\s*\{([^}]+)\}[^\n]*branding-env\.cjs[^\n]*/g)).flatMap(m => m[1].split(",").map(x => x.trim())));
  const imports = Array.from(names).filter(name => !imported.has(name)).sort().join(", ");
  const line = path.endsWith(".cjs") ? `const { ${imports} } = require("${rel}");\n` : `import { ${imports} } from "${rel}";\n`;
  const position = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0;
  if (imports) text = text.slice(0, position) + line + text.slice(position);
  const seen = new Set();
  text = text.split("\n").filter(line => {
    if (!/^(?:import|const) .*branding-env\.cjs/.test(line)) return true;
    if (seen.has(line)) return false;
    seen.add(line); return true;
  }).join("\n");
  writeFileSync(file, text);
}
if (count) process.exitCode = 1;
