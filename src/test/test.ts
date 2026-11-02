/**
 * vjson 综合测试 — 仅使用公开 API：parse / stringify
 *
 *   node --experimental-strip-types test/test.ts
 *
 * target/：
 *   main.data.json         — parse 得到的 JS 对象序列化
 *   main.ir.json           — parse({ ir: true }) 的 ir
 *   main.from-ir.vjson     — stringify(ir)
 *   main.from-obj.vjson    — stringify(data)
 *   main.roundtrip.json    — 再 parse 校验
 *   errors/*.txt
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "../index.ts";
import type { ModuleIRJson } from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures");
const targetDir = path.join(__dirname, "..", "target");
const targetErrDir = path.join(targetDir, "errors");

function f(name: string) {
  return path.join(fixtures, name);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${msg}  (got ${a}, want ${e})`);
}

function approx(actual: unknown, expected: number, msg: string, eps = 1e-12) {
  ok(
    typeof actual === "number" && Math.abs(actual - expected) < eps,
    `${msg}  (got ${actual}, want ≈ ${expected})`,
  );
}

function includes(text: string, sub: string, msg: string) {
  ok(text.includes(sub), `${msg}`);
}

async function expectThrow(
  fn: () => Promise<unknown>,
  substr: string,
  msg: string,
): Promise<string | null> {
  try {
    await fn();
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}  (expected throw)`);
    return null;
  } catch (e) {
    const text = String(e instanceof Error ? e.message : e);
    ok(text.includes(substr), `${msg}`);
    return text;
  }
}

async function ensureTarget() {
  await fs.mkdir(targetErrDir, { recursive: true });
}

async function testHappyPath() {
  console.log("\n=== parse / stringify happy path ===");

  type MainShape = {
    lit_num: number;
    lit_str: string;
    tso: number;
    xa: number;
    t1_kvs: number;
    rj: string;
  };

  // 显式 T（推荐；大文件勿依赖默认推导）
  const data = await parse<MainShape>(f("main.vjson"));
  ok(typeof data === "object" && data !== null, "parse returns JS object");
  ok(!Array.isArray(data), "parse returns plain object not array");

  // 运行时直接使用字段（不是 JSON 字符串）
  eq(data.lit_num, 42, "lit_num");
  eq(data.lit_str, "hello", "lit_str");
  eq(data.tso, 123, "tso");
  eq(data.xa, 1, "xa");
  eq(data.t1_kvs, 5, "t1_kvs");
  eq(data.rj, "rj1538", "rj");

  const full = await parse(f("main.vjson"));
  eq(full.lit_bool, true, "lit_bool");
  eq(full.lit_null, null, "lit_null");
  eq(full.lit_arr, [1, 2, 3], "lit_arr");
  eq(full.n, 20, "n");
  eq(full.cst, 15.25, "cst");
  eq(full.hex_v, 255, "hex");
  eq(full.bin_v, 10, "bin");
  approx(full.sci_v, 0.0015, "sci");
  eq(full.other_rj, "from_other", "other_rj");
  eq(full.mixed, [123, 1, null, "end"], "mixed");
  ok(!("secret" in full), "no dep leak");

  // parse + ir
  const { data: data2, ir } = await parse(f("main.vjson"), { ir: true });
  eq(data2.tso, 123, "with-ir data.tso");
  ok(Array.isArray(ir.scopeOrder), "ir.scopeOrder");
  ok(!!ir.scopes.var, "ir has var");
  ok(!!ir.scopes.tops, "ir has tops");

  await fs.writeFile(
    path.join(targetDir, "main.data.json"),
    JSON.stringify(data2, null, 2),
    "utf-8",
  );
  await fs.writeFile(
    path.join(targetDir, "main.ir.json"),
    JSON.stringify(ir, null, 2),
    "utf-8",
  );
  console.log("  > wrote target/main.data.json, main.ir.json");

  // stringify(ir) > 完整 vjson
  const fromIr = stringify(ir);
  await fs.writeFile(path.join(targetDir, "main.from-ir.vjson"), fromIr, "utf-8");
  console.log("  > wrote target/main.from-ir.vjson");
  includes(fromIr, "import", "stringify(ir) has import");
  includes(fromIr, "&tops.tops1", "stringify(ir) keeps & ref");
  includes(fromIr, "&!xxx.a", "stringify(ir) keeps &!");
  includes(fromIr, "var = {", "stringify(ir) has var");

  // stringify(obj) > 仅 var 字面量
  const fromObj = stringify(data2 as Record<string, unknown>);
  await fs.writeFile(
    path.join(targetDir, "main.from-obj.vjson"),
    fromObj,
    "utf-8",
  );
  console.log("  > wrote target/main.from-obj.vjson");
  includes(fromObj, "var = {", "stringify(obj) has var");
  includes(fromObj, "lit_num = 42", "stringify(obj) has lit_num");
  ok(!fromObj.includes("&tops"), "stringify(obj) has no refs");

  // parse({ json: true })
  const jsonText = await parse(f("main.vjson"), { json: true });
  ok(typeof jsonText === "string", "parse json option returns string");
  eq(JSON.parse(jsonText).tso, 123, "json text parses to same tso");

  return { data: data2, ir };
}

async function testIrRoundtrip(ir: ModuleIRJson) {
  console.log("\n=== stringify(ir) > parse roundtrip ===");

  const src = stringify(ir);
  const tmp = path.join(fixtures, "_roundtrip_main.vjson");
  await fs.writeFile(tmp, src, "utf-8");
  try {
    const again = await parse(tmp);
    eq(again.tso, 123, "roundtrip tso");
    eq(again.xa, 1, "roundtrip xa");
    eq(again.rj, "rj1538", "roundtrip rj");
    eq(again.t1_kvs, 5, "roundtrip t1_kvs");

    await fs.writeFile(
      path.join(targetDir, "main.roundtrip.json"),
      JSON.stringify(again, null, 2),
      "utf-8",
    );
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function testObjRoundtrip() {
  console.log("\n=== stringify(obj) > parse ===");
  const obj = { hello: "world", n: 7, flag: true, nested: { a: 1 } };
  const src = stringify(obj);
  const tmp = path.join(fixtures, "_obj_only.vjson");
  await fs.writeFile(tmp, src, "utf-8");
  try {
    const back = await parse(tmp);
    eq(back.hello, "world", "obj hello");
    eq(back.n, 7, "obj n");
    eq(back.flag, true, "obj flag");
    eq(back.nested, { a: 1 }, "obj nested");
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function testErrors() {
  console.log("\n=== errors ===");
  const cases: { file: string; substr: string; msg: string }[] = [
    { file: "err_dup_field.vjson", substr: "Duplicate field", msg: "dup field" },
    { file: "err_forward_ref.vjson", substr: "doesn't exist", msg: "forward ref" },
    { file: "err_cross_scope.vjson", substr: "Cross-scope", msg: "cross scope" },
    { file: "err_operator.vjson", substr: "Operators are not supported", msg: "operator" },
    { file: "err_bang_missing.vjson", substr: "does not exist", msg: "bang missing" },
    { file: "err_index.vjson", substr: "Index out of range", msg: "index" },
    { file: "err_cycle.vjson", substr: "Circular reference", msg: "cycle" },
    { file: "err_import_no_alias.vjson", substr: "requires an alias", msg: "import alias" },
  ];
  for (const c of cases) {
    const text = await expectThrow(() => parse(f(c.file)), c.substr, c.msg);
    if (text) {
      await fs.writeFile(
        path.join(targetErrDir, c.file.replace(/\.vjson$/, ".txt")),
        text,
        "utf-8",
      );
    }
  }
}

async function main() {
  console.log("vjson tests (parse / stringify only)");
  console.log("fixtures:", fixtures);
  await ensureTarget();

  let ir: ModuleIRJson | null = null;
  try {
    const r = await testHappyPath();
    ir = r.ir;
  } catch (e) {
    failed++;
    failures.push("happy: " + String(e));
    console.error(e);
  }

  if (ir) {
    try {
      await testIrRoundtrip(ir);
    } catch (e) {
      failed++;
      failures.push("ir roundtrip: " + String(e));
      console.error(e);
    }
  }

  try {
    await testObjRoundtrip();
  } catch (e) {
    failed++;
    failures.push("obj roundtrip: " + String(e));
    console.error(e);
  }

  try {
    await testErrors();
  } catch (e) {
    failed++;
    failures.push("errors: " + String(e));
    console.error(e);
  }

  console.log("\n========================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    for (const m of failures) console.log("  -", m);
  }
  try {
    const files = await fs.readdir(targetDir, { recursive: true });
    console.log("target:", files.join(", "));
  } catch {
    /* */
  }
  console.log("========================================\n");
  if (failed > 0) process.exit(1);
}

main();
