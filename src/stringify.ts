/**
 * vjson stringify — 求值并把入口 var 输出为 JSON 对象 / 字符串
 *
 * 查找规则（README §3.4 / §3.5 / §3.11）：
 *   local  > 仅当前作用域已定义字段；若其它作用域有同名 > Cross-scope requires '&'
 *   scope  > bang 或 tops/var > 顶级作用域；否则当作 tops 下字段
 *   alias  > bang > dep 顶级作用域；否则 dep.tops
 */

import path from "node:path";
import { loadModules } from "./parse.ts";
import type {
  ModuleIR,
  ScopeIR,
  NodeIR,
  RefNode,
  PathSegment,
  FieldIR,
  Loc,
  ModuleInfo,
  ModuleValues,
  VjsonEvalError,
  VjsonEvalErrorType,
} from "./common.ts";
import { deepClone, formatEvalErrors } from "./common.ts";

export class EvalContext {
  private moduleList: ModuleInfo[];
  private moduleValues = new Map<number, ModuleValues>();
  private evaluatingModules = new Set<number>();
  private cycleSet = new Set<string>();
  errors: VjsonEvalError[] = [];

  constructor(moduleList: ModuleInfo[]) {
    this.moduleList = moduleList;
  }

  getModuleValues(fileIndex: number): ModuleValues {
    if (this.moduleValues.has(fileIndex))
      return this.moduleValues.get(fileIndex)!;

    if (this.evaluatingModules.has(fileIndex)) {
      throw new Error(`[Cycle Error] Circular module reference`);
    }
    this.evaluatingModules.add(fileIndex);

    const mod = this.moduleList[fileIndex];
    if (!mod.ir) {
      this.evaluatingModules.delete(fileIndex);
      throw new Error(`[Type Error] Module IR not available: ${mod.path}`);
    }

    const vals = this.evaluateModule(mod.ir);
    this.moduleValues.set(fileIndex, vals);
    this.evaluatingModules.delete(fileIndex);
    return vals;
  }

  getAllModuleValues(): Map<number, ModuleValues> {
    return this.moduleValues;
  }

  /**
   * 按 scopeOrder（书写顺序）求值。
   * README §3.1 / §5.3：后者可访问前者，前者不可访问后者。
   */
  private evaluateModule(mod: ModuleIR): ModuleValues {
    const scopes = new Map<string, Map<string, unknown>>();

    for (const scopeName of mod.scopeOrder) {
      const scope = mod.scopes.get(scopeName)!;
      const fieldVals = new Map<string, unknown>();
      scopes.set(scopeName, fieldVals);

      for (const field of scope.fields) {
        try {
          const v = this.evaluateField(mod, scope, field, scopes);
          fieldVals.set(field.name, v);
        } catch (e: any) {
          this.errors.push({
            type: e.vjsonType ?? "Type Error",
            message: e.vjsonMessage ?? String(e?.message ?? e),
            fileIndex: field.loc.fileIndex,
            line: field.loc.line,
            col: field.loc.col,
          });
        }
      }
    }

    return { scopes };
  }

  private evaluateField(
    mod: ModuleIR,
    scope: ScopeIR,
    field: FieldIR,
    scopes: Map<string, Map<string, unknown>>,
  ): unknown {
    const key = `${mod.fileIndex}:${scope.name}.${field.name}`;
    if (this.cycleSet.has(key)) {
      this.throwError(
        "Cycle Error",
        `Circular reference detected: ${key}`,
        field.loc,
      );
    }
    this.cycleSet.add(key);
    try {
      return this.evaluateNode(field.value, mod, scope, scopes);
    } finally {
      this.cycleSet.delete(key);
    }
  }

  private evaluateNode(
    node: NodeIR,
    mod: ModuleIR,
    scope: ScopeIR,
    scopes: Map<string, Map<string, unknown>>,
  ): unknown {
    switch (node.kind) {
      case "literal":
        return node.value;
      case "array":
        return node.items.map((n) => this.evaluateNode(n, mod, scope, scopes));
      case "object": {
        const out: Record<string, unknown> = {};
        for (const f of node.fields) {
          out[f.name] = this.evaluateNode(f.value, mod, scope, scopes);
        }
        return out;
      }
      case "ref":
        return this.evaluateRef(node, mod, scope, scopes);
    }
  }

  /**
   * 引用求值 — 严格对齐 README §3.4 / §3.5 / §3.11
   *
   * local:
   *   1. 当前作用域已定义 > 取之
   *   2. 其它作用域有同名 > Cross-scope requires '&'
   *   3. 否则 doesn't exist
   *   （裸名不自动回退 tops；跨作用域必须显式 &，见 §3.5 示例）
   */
  private evaluateRef(
    node: RefNode,
    mod: ModuleIR,
    scope: ScopeIR,
    scopes: Map<string, Map<string, unknown>>,
  ): unknown {
    let root: unknown;
    let restPath: PathSegment[];

    if (node.base.kind === "local") {
      const cur = scopes.get(scope.name);
      const firstName = node.path[0];
      if (!firstName || firstName.kind !== "field") {
        this.throwError("Reference Error", "Invalid local reference", node.loc);
      }
      if (cur?.has(firstName.name)) {
        root = cur.get(firstName.name);
        restPath = node.path.slice(1);
      } else {
        // 正在求值中的字段 > 循环引用（README §7.1 Cycle Error）
        this.checkFieldCycle(
          mod.fileIndex,
          scope.name,
          firstName.name,
          node.loc,
        );
        // 其它作用域是否有同名 > 提示必须用 &
        for (const [scopeName, scopeVals] of scopes) {
          if (scopeName !== scope.name && scopeVals.has(firstName.name)) {
            this.throwError(
              "Reference Error",
              `Cross-scope reference requires '&': ${firstName.name}`,
              node.loc,
            );
          }
        }
        this.throwError(
          "Reference Error",
          `This variable doesn't exist: ${firstName.name}`,
          node.loc,
        );
      }
    } else if (node.base.kind === "scope") {
      const name = node.base.name;

      // tops / var / bang > 按顶级作用域取
      // 无 bang 的自定义名 > 当作 tops 下字段（README §3.11）
      if (name === "tops" || name === "var" || node.bang) {
        const vals = scopes.get(name);
        if (!vals) {
          this.throwError(
            "Reference Error",
            `Top-level scope '${name}' doesn't exist`,
            node.loc,
          );
        }
        if (node.path.length === 0) return this.scopeToObject(vals!);
        const firstName = node.path[0];
        if (firstName.kind !== "field") {
          this.throwError("Type Error", "Expected field access", node.loc);
        }
        if (!vals!.has(firstName.name)) {
          this.checkFieldCycle(mod.fileIndex, name, firstName.name, node.loc);
          this.throwError(
            "Reference Error",
            `This variable doesn't exist: ${firstName.name}`,
            node.loc,
          );
        }
        root = vals!.get(firstName.name);
        restPath = node.path.slice(1);
      } else {
        const tops = scopes.get("tops");
        if (!tops || !tops.has(name)) {
          this.checkFieldCycle(mod.fileIndex, "tops", name, node.loc);
          this.throwError(
            "Reference Error",
            `This variable doesn't exist: ${name}`,
            node.loc,
          );
        }
        root = tops!.get(name);
        restPath = node.path;
      }
    } else {
      // alias
      const aliasName = node.base.name;
      const imp = mod.imports.find((i) => i.alias === aliasName);
      if (!imp || imp.fileIndex === undefined) {
        this.throwError(
          "Reference Error",
          `Import alias doesn't exist: ${aliasName}`,
          node.loc,
        );
      }
      const depVals = this.getModuleValues(imp!.fileIndex!);

      if (node.bang) {
        if (node.path.length === 0) {
          this.throwError(
            "Reference Error",
            "'!' requires a top-level scope name",
            node.loc,
          );
        }
        const first = node.path[0];
        if (first.kind !== "field") {
          this.throwError(
            "Type Error",
            "Expected scope name after '!'",
            node.loc,
          );
        }
        const depScope = depVals.scopes.get(first.name);
        if (!depScope) {
          this.throwError(
            "Reference Error",
            `Top-level scope '${first.name}' doesn't exist in module '${aliasName}'`,
            node.loc,
          );
        }
        if (node.path.length === 1) return this.scopeToObject(depScope!);
        const next = node.path[1];
        if (next.kind !== "field") {
          this.throwError("Type Error", "Expected field access", node.loc);
        }
        if (!depScope!.has(next.name)) {
          this.throwError(
            "Reference Error",
            `This variable doesn't exist: ${next.name}`,
            node.loc,
          );
        }
        root = depScope!.get(next.name);
        restPath = node.path.slice(2);
      } else {
        if (node.path.length === 0) return this.moduleToObject(depVals);
        const depTops = depVals.scopes.get("tops");
        const firstName = node.path[0];
        if (firstName.kind !== "field") {
          this.throwError("Type Error", "Expected field access", node.loc);
        }
        if (!depTops || !depTops.has(firstName.name)) {
          this.throwError(
            "Reference Error",
            `This variable doesn't exist: ${firstName.name}`,
            node.loc,
          );
        }
        root = depTops!.get(firstName.name);
        restPath = node.path.slice(1);
      }
    }

    return this.descend(root, restPath, node.loc);
  }

  private descend(root: unknown, path: PathSegment[], loc: Loc): unknown {
    let cur = root;
    for (const seg of path) {
      if (seg.kind === "field") {
        if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
          this.throwError(
            "Type Error",
            `Cannot access field '${seg.name}' of non-object`,
            loc,
          );
        }
        if (!(seg.name in (cur as Record<string, unknown>))) {
          this.throwError(
            "Reference Error",
            `This variable doesn't exist: ${seg.name}`,
            loc,
          );
        }
        cur = (cur as Record<string, unknown>)[seg.name];
      } else {
        if (!Array.isArray(cur)) {
          this.throwError("Type Error", `Cannot index non-array`, loc);
        }
        if (seg.value < 0 || seg.value >= cur.length) {
          this.throwError(
            "Index Error",
            `Index out of range: ${seg.value}`,
            loc,
          );
        }
        cur = cur[seg.value];
      }
    }
    return cur;
  }

  /** 整作用域 > 普通对象（深拷贝，README §3.7） */
  private scopeToObject(vals: Map<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of vals) out[k] = deepClone(v);
    return out;
  }

  private moduleToObject(vals: ModuleValues): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [scopeName, fields] of vals.scopes) {
      out[scopeName] = this.scopeToObject(fields);
    }
    return out;
  }

  /** 若目标字段正在求值中，则判定为循环引用 */
  private checkFieldCycle(
    fileIndex: number,
    scopeName: string,
    fieldName: string,
    loc: Loc,
  ) {
    const key = `${fileIndex}:${scopeName}.${fieldName}`;
    if (this.cycleSet.has(key)) {
      this.throwError(
        "Cycle Error",
        `Circular reference detected: ${key}`,
        loc,
      );
    }
  }

  private throwError(
    type: VjsonEvalErrorType,
    message: string,
    loc: Loc,
  ): never {
    const err: any = new Error(message);
    err.vjsonType = type;
    err.vjsonMessage = message;
    err.vjsonLoc = loc;
    throw err;
  }
}

export async function stringifyWithDebug(entryPath: string) {
  const parseResult = await loadModules(entryPath);
  const { entryIndex, moduleList, fileList, astList, irList } = parseResult;

  const ctx = new EvalContext(moduleList);
  const entryVals = ctx.getModuleValues(entryIndex);

  if (ctx.errors.length > 0) {
    throw new Error(formatEvalErrors(ctx.errors, moduleList));
  }

  // README §2.4 / §6：只导出入口模块的 var
  const varVals = entryVals.scopes.get("var");
  const output: Record<string, unknown> = {};
  if (varVals) for (const [k, v] of varVals) output[k] = deepClone(v);

  return {
    output,
    ctx,
    entryIndex,
    moduleList,
    fileList,
    astList,
    irList,
  };
}

/**
 * 公开入口：求值入口模块 var，返回深拷贝对象（可直接 JSON 序列化）
 */
export async function stringify(
  entryPath: string,
): Promise<Record<string, unknown>> {
  const { output } = await stringifyWithDebug(entryPath);
  return output;
}

/**
 * 求值并返回格式化 JSON 字符串
 */
export async function stringifyToJson(
  entryPath: string,
  space: number | string = 2,
): Promise<string> {
  const output = await stringify(entryPath);
  return JSON.stringify(output, null, space);
}

/** @deprecated 使用 stringify */
export const evaluate = stringify;
/** @deprecated 使用 stringifyWithDebug */
export const evaluateWithDebug = stringifyWithDebug;

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).replaceAll("\\", "/") ===
    path.resolve(import.meta.filename ?? "").replaceAll("\\", "/");

if (isMain) {
  const target = process.argv[2] ?? "./data.vjson";
  try {
    const result = await stringify(target);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
