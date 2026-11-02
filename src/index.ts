/**
 * vjson 公开 API（仅导出 parse / stringify）
 *
 * parse(path) > JS 对象（入口 var）
 * parse(path,{ir}) > { data, ir }
 * parse(path,{json}) > JSON 字符串
 *
 * stringify(obj) > 纯数据写成 var = { ... } 的 vjson 文本
 * stringify(ir) > 从 IR 还原完整 vjson（含 import / & 引用）
 *
 * 每次调用独立会话，无跨调用全局缓存。
 * 语言本身无类型系统；TS 侧可用 parse<T>() 标注返回类型。
 */

import { loadModules } from "./parse.ts";
import { EvalContext } from "./stringify.ts";
import { decompileModule } from "./decompile.ts";
import type {
  ModuleIR,
  ScopeIR,
  NodeIR,
  FieldIR,
  ImportRef,
} from "./common.ts";
import { deepClone, formatEvalErrors } from "./common.ts";

export type PathSegmentJson =
  | { kind: "field"; name: string }
  | { kind: "index"; value: number };

export type NodeIRJson =
  | { kind: "literal"; value: number | string | boolean | null }
  | { kind: "array"; items: NodeIRJson[] }
  | { kind: "object"; fields: FieldIRJson[] }
  | {
      kind: "ref";
      base:
        | { kind: "local" }
        | { kind: "scope"; name: string }
        | { kind: "alias"; name: string };
      bang: boolean;
      path: PathSegmentJson[];
    };

export type FieldIRJson = { name: string; value: NodeIRJson };

export type ScopeIRJson = {
  name: string;
  kind: "tops" | "var" | "custom";
  fields: FieldIRJson[];
};

export type ModuleIRJson = {
  path: string;
  imports: { raw: string; alias: string }[];
  scopeOrder: string[];
  scopes: Record<string, ScopeIRJson>;
};

export type ParseWithIr<T = Record<string, unknown>> = {
  data: T;
  ir: ModuleIRJson;
};

function nodeToJson(node: NodeIR): NodeIRJson {
  switch (node.kind) {
    case "literal":
      return { kind: "literal", value: node.value };
    case "array":
      return { kind: "array", items: node.items.map(nodeToJson) };
    case "object":
      return {
        kind: "object",
        fields: node.fields.map((f) => ({
          name: f.name,
          value: nodeToJson(f.value),
        })),
      };
    case "ref":
      return {
        kind: "ref",
        base: node.base,
        bang: node.bang,
        path: node.path,
      };
  }
}

function nodeFromJson(
  node: NodeIRJson,
  loc = { fileIndex: 0, line: 0, col: 0 },
): NodeIR {
  switch (node.kind) {
    case "literal":
      return { kind: "literal", value: node.value, loc };
    case "array":
      return {
        kind: "array",
        items: node.items.map((x) => nodeFromJson(x, loc)),
        loc,
      };
    case "object":
      return {
        kind: "object",
        fields: node.fields.map((f) => ({
          name: f.name,
          value: nodeFromJson(f.value, loc),
          loc,
        })),
        loc,
      };
    case "ref":
      return {
        kind: "ref",
        base: node.base,
        bang: node.bang,
        path: node.path,
        loc,
      };
  }
}

function moduleIrToJson(ir: ModuleIR): ModuleIRJson {
  const scopes: Record<string, ScopeIRJson> = {};
  for (const [name, scope] of ir.scopes) {
    scopes[name] = {
      name: scope.name,
      kind: scope.kind,
      fields: scope.fields.map((f) => ({
        name: f.name,
        value: nodeToJson(f.value),
      })),
    };
  }
  return {
    path: ir.path,
    imports: ir.imports.map((i) => ({ raw: i.raw, alias: i.alias })),
    scopeOrder: [...ir.scopeOrder],
    scopes,
  };
}

function moduleIrFromJson(j: ModuleIRJson): ModuleIR {
  const scopes = new Map<string, ScopeIR>();
  for (const name of j.scopeOrder) {
    const s = j.scopes[name];
    if (!s) continue;
    scopes.set(name, {
      name: s.name,
      kind: s.kind,
      fields: s.fields.map((f) => ({
        name: f.name,
        value: nodeFromJson(f.value),
        loc: { fileIndex: 0, line: 0, col: 0 },
      })),
      loc: { fileIndex: 0, line: 0, col: 0 },
    });
  }
  return {
    fileIndex: 0,
    path: j.path,
    imports: j.imports.map(
      (i): ImportRef => ({ raw: i.raw, alias: i.alias, line: 0, col: 0 }),
    ),
    scopes,
    scopeOrder: [...j.scopeOrder],
  };
}

function isModuleIRJson(x: unknown): x is ModuleIRJson {
  return (
    !!x &&
    typeof x === "object" &&
    Array.isArray((x as ModuleIRJson).scopeOrder) &&
    typeof (x as ModuleIRJson).scopes === "object" &&
    (x as ModuleIRJson).scopes !== null &&
    !Array.isArray((x as ModuleIRJson).scopes)
  );
}

function isRuntimeModuleIR(x: unknown): x is ModuleIR {
  return (
    !!x &&
    typeof x === "object" &&
    (x as ModuleIR).scopes instanceof Map &&
    Array.isArray((x as ModuleIR).scopeOrder)
  );
}

function escapeString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    switch (c) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default: {
        const code = c.charCodeAt(0);
        if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
        else out += c;
      }
    }
  }
  return out;
}

function isIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function valueToVjson(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);

  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return String(value);
  }
  if (typeof value === "string") return `"${escapeString(value)}"`;

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const parts = value.map((v) => valueToVjson(v, indent + 1));
    const flat = parts.join(", ");
    if (flat.length < 60 && !parts.some((p) => p.includes("\n"))) {
      return `[${flat}]`;
    }
    return "[\n" + parts.map((p) => pad1 + p).join(",\n") + "\n" + pad + "]";
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([k]) => isIdent(k),
    );
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => {
      return `${pad1}${k} = ${valueToVjson(v, indent + 1)}`;
    });
    return "{\n" + lines.join(",\n") + "\n" + pad + "}";
  }

  // function / symbol / undefined > null
  return "null";
}

/** 普通 JS 对象 > 仅含 var 的 vjson 源码 */
function objectToVjson(obj: Record<string, unknown>): string {
  const body = valueToVjson(obj, 0);
  // body 已是 { ... }，包成 var = { ... };
  if (body.startsWith("{")) {
    return `var = ${body};\n`;
  }
  return `var = {\n  value = ${body}\n};\n`;
}

async function run(entryPath: string) {
  const loaded = await loadModules(entryPath);
  const { entryIndex, moduleList } = loaded;
  const ctx = new EvalContext(moduleList);
  const entryVals = ctx.getModuleValues(entryIndex);
  if (ctx.errors.length > 0) {
    throw new Error(formatEvalErrors(ctx.errors, moduleList));
  }
  const varVals = entryVals.scopes.get("var");
  const data: Record<string, unknown> = {};
  if (varVals) for (const [k, v] of varVals) data[k] = deepClone(v);
  const ir = moduleList[entryIndex]?.ir;
  return { data, ir };
}

export type ParseOptions =
  | { ir?: false; json?: false }
  | { ir: true; json?: false }
  | { json: true; ir?: boolean };

/**
 * 将 `.vjson` 解析并求值为 **JS 对象**（入口 `var`）。
 *
 * - 语言本身无类型系统；TS 可用泛型 `parse<MyConfig>(path)` 标注返回类型。
 * - **未传 `T` 时**默认为 `Record<string, unknown>`。
 * - 源文件或结构较大（经验阈值约 **1500 字符**）时请**显式传入 `T`**，
 *   不要依赖自动推导（推导易退化成宽类型或拖慢 IDE）。
 *
 * @example
 * const cfg = await parse("./app.vjson");
 * const cfg2 = await parse<AppConfig>("./app.vjson");
 * const { data, ir } = await parse("./app.vjson", { ir: true });
 * const text = await parse("./app.vjson", { json: true });
 */
export async function parse(
  entryPath: string,
  options: { json: true; ir?: boolean },
): Promise<string>;
export async function parse<T = Record<string, unknown>>(
  entryPath: string,
  options: { ir: true; json?: false },
): Promise<ParseWithIr<T>>;
export async function parse<T = Record<string, unknown>>(
  entryPath: string,
  options?: { ir?: false; json?: false },
): Promise<T>;
export async function parse<T = Record<string, unknown>>(
  entryPath: string,
  options?: ParseOptions,
): Promise<T | ParseWithIr<T> | string> {
  const { data, ir } = await run(entryPath);
  const typed = data as T;

  if (options?.json) {
    return JSON.stringify(typed, null, 2);
  }
  if (options?.ir) {
    if (!ir) throw new Error("[Type Error] Module IR not available");
    return { data: typed, ir: moduleIrToJson(ir) };
  }
  return typed;
}

/**
 * 将 **JS 对象** 或 **IR** 转为 `.vjson` 源码字符串。
 *
 * - 传入 IR（`parse(..., { ir: true }).ir` 或运行时 ModuleIR）> 还原完整模块（import / & 引用）。
 * - 传入普通对象 > 写成单文件 `var = { ... };`（仅字面量，无跨作用域引用）。
 */
export function stringify(
  input: ModuleIRJson | ModuleIR | Record<string, unknown> | unknown,
): string {
  if (isRuntimeModuleIR(input)) {
    return decompileModule(input);
  }
  if (isModuleIRJson(input)) {
    return decompileModule(moduleIrFromJson(input));
  }
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return objectToVjson(input as Record<string, unknown>);
  }
  // 顶层数组 / 原始值：包进 var.value
  return objectToVjson({ value: input as unknown });
}
