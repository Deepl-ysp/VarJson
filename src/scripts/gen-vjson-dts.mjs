/**
 * 从 .vjson 生成可供 parse<T> 使用的类型文件
 *
 *   node --experimental-strip-types scripts/gen-vjson-dts.mjs test/fixtures/main.vjson
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

function typeOf(value, indent = 0, depth = 0) {
  if (depth > 12) return "unknown";
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) {
    if (!value.length) return "unknown[]";
    const types = [...new Set(value.map((v) => typeOf(v, indent, depth + 1)))];
    if (types.length === 1) return types[0] + "[]";
    return "(" + types.join(" | ") + ")[]";
  }
  if (typeof value === "object") {
    const pad = "  ".repeat(indent);
    const pad1 = "  ".repeat(indent + 1);
    const lines = Object.entries(value).map(([k, v]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
      return `${pad1}${key}: ${typeOf(v, indent + 1, depth + 1)};`;
    });
    return `{\n${lines.join("\n")}\n${pad}}`;
  }
  return "unknown";
}

function toTypeName(file) {
  const base = path.basename(file, path.extname(file));
  const parts = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return (pascal || "Config") + "Vjson";
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node gen-vjson-dts.mjs <file.vjson>");
  process.exit(1);
}
const abs = path.resolve(file);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.env.VJSON_RUNTIME || path.join(root, "index.ts");
const mod = await import(pathToFileURL(runtime).href);
const data = await mod.parse(abs);
const typeName = toTypeName(abs);
const dir = path.dirname(abs);
const base = path.basename(abs, path.extname(abs));
const dtsPath = path.join(dir, base + ".vjson.d.ts");
const body = `/** Auto-generated from ${path.basename(abs)} — 勿手改；改 vjson 后请重新生成 */\nexport type ${typeName} = ${typeOf(data)};\n\nexport default ${typeName};\n`;
fs.writeFileSync(dtsPath, body, "utf-8");
fs.writeFileSync(path.join(dir, base + ".data.json"), JSON.stringify(data, null, 2), "utf-8");
console.log("wrote", dtsPath);
console.log("type ", typeName);
console.log(`\n用法:\n  import type { ${typeName} } from "./${base}.vjson";\n  const confs = await parse<${typeName}>("./${base}.vjson");\n`);
