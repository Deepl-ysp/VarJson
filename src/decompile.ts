/**
 * vjson decompile — 从 IR 反编译回 .vjson 源码字符串
 *
 * IR 中的 kind / base / bang / path 即「符号字段」，据此还原语法：
 *   literal / array / object / ref(&, !, ., [])
 */

import type {
  ModuleIR,
  NodeIR,
  RefNode,
  PathSegment,
  FieldIR,
  ScopeIR,
  ImportRef,
} from "./common.ts";

function decompileLiteral(value: number | string | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    // 保持可读十进制；十六进制等在 IR 里已是 number，无法还原原始写法
    return String(value);
  }
  // string：双引号 + 转义
  return `"${escapeString(value)}"`;
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
        if (code < 0x20) {
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          out += c;
        }
      }
    }
  }
  return out;
}

function decompilePathSuffix(path: PathSegment[]): string {
  let s = "";
  for (const seg of path) {
    if (seg.kind === "field") {
      s += "." + seg.name;
    } else {
      s += "[" + seg.value + "]";
    }
  }
  return s;
}

/**
 * 反编译 RefNode：
 *   local: a / a.b / a[0]
 *   scope: &tops.x / &!xxx.a / &xxx（整作用域）
 *   alias: &t1.rcs / &t1.!other.rj / &t1（整模块）
 */
export function decompileRef(node: RefNode): string {
  const { base, bang, path } = node;

  if (base.kind === "local") {
    // path[0] 必为 field
    if (path.length === 0) return "/* invalid local ref */";
    const head = path[0];
    if (head.kind !== "field") return "/* invalid local ref */";
    return head.name + decompilePathSuffix(path.slice(1));
  }

  if (base.kind === "scope") {
    if (bang) {
      // &!scope 或 &!scope.path
      if (path.length === 0) return `&!${base.name}`;
      return `&!${base.name}` + decompilePathSuffix(path);
    }
    // &scope 或 &scope.path
    if (path.length === 0) return `&${base.name}`;
    return `&${base.name}` + decompilePathSuffix(path);
  }

  // alias
  if (bang) {
    // &alias.!scope 或 &alias.!scope.path
    // IR：path[0] 为作用域名
    if (path.length === 0) return `&${base.name}.!/*missing*/`;
    const scopeSeg = path[0];
    if (scopeSeg.kind !== "field") return `&${base.name}.!/*bad*/`;
    return (
      `&${base.name}.!${scopeSeg.name}` + decompilePathSuffix(path.slice(1))
    );
  }
  if (path.length === 0) return `&${base.name}`;
  return `&${base.name}` + decompilePathSuffix(path);
}

export function decompileNode(node: NodeIR, indent = 0): string {
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);

  switch (node.kind) {
    case "literal":
      return decompileLiteral(node.value);

    case "array": {
      if (node.items.length === 0) return "[]";
      const parts = node.items.map((it) => decompileNode(it, indent + 1));
      // 短数组单行
      const flat = parts.join(", ");
      if (flat.length < 60 && !parts.some((p) => p.includes("\n"))) {
        return `[${flat}]`;
      }
      return "[\n" + parts.map((p) => pad1 + p).join(",\n") + "\n" + pad + "]";
    }

    case "object": {
      if (node.fields.length === 0) return "{}";
      const lines = node.fields.map((f) => {
        const v = decompileNode(f.value, indent + 1);
        if (v.includes("\n")) {
          return `${pad1}${f.name} = ${v}`;
        }
        return `${pad1}${f.name} = ${v}`;
      });
      return "{\n" + lines.join(",\n") + "\n" + pad + "}";
    }

    case "ref":
      return decompileRef(node);
  }
}

function decompileFields(fields: FieldIR[], indent: number): string {
  if (fields.length === 0) return "{}";
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);
  const lines = fields.map((f) => {
    const v = decompileNode(f.value, indent + 1);
    return `${pad1}${f.name} = ${v}`;
  });
  return "{\n" + lines.join(",\n") + "\n" + pad + "}";
}

function decompileImport(imp: ImportRef): string {
  return `import "${escapeString(imp.raw)}" as ${imp.alias};`;
}

function decompileScope(scope: ScopeIR): string {
  return `${scope.name} = ${decompileFields(scope.fields, 0)};`;
}

export function decompileModule(ir: ModuleIR): string {
  const parts: string[] = [];

  for (const imp of ir.imports) {
    parts.push(decompileImport(imp));
  }
  if (ir.imports.length > 0) parts.push("");

  for (const name of ir.scopeOrder) {
    const scope = ir.scopes.get(name);
    if (!scope) continue;
    parts.push(decompileScope(scope));
    parts.push("");
  }

  return (
    parts
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

export function decompileFromParseResult(result: {
  entryIndex: number;
  moduleList: { ir?: ModuleIR }[];
}): string {
  const mod = result.moduleList[result.entryIndex];
  if (!mod?.ir) {
    throw new Error("[Type Error] Module IR not available for decompile");
  }
  return decompileModule(mod.ir);
}

export type TaggedValue =
  | null
  | boolean
  | number
  | string
  | TaggedValue[]
  | { [k: string]: TaggedValue }
  | {
      $ref: true;
      base: RefNode["base"];
      bang: boolean;
      path: PathSegment[];
    };

export function nodeToTagged(node: NodeIR): TaggedValue {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "array":
      return node.items.map(nodeToTagged);
    case "object": {
      const o: { [k: string]: TaggedValue } = {};
      for (const f of node.fields) o[f.name] = nodeToTagged(f.value);
      return o;
    }
    case "ref":
      return {
        $ref: true,
        base: node.base,
        bang: node.bang,
        path: node.path,
      };
  }
}

export function taggedToNode(
  tagged: TaggedValue,
  loc = { fileIndex: 0, line: 0, col: 0 },
): NodeIR {
  if (
    tagged !== null &&
    typeof tagged === "object" &&
    !Array.isArray(tagged) &&
    (tagged as { $ref?: boolean }).$ref === true
  ) {
    const t = tagged as {
      $ref: true;
      base: RefNode["base"];
      bang: boolean;
      path: PathSegment[];
    };
    return { kind: "ref", base: t.base, bang: t.bang, path: t.path, loc };
  }
  if (tagged === null || typeof tagged !== "object") {
    return {
      kind: "literal",
      value: tagged as null | boolean | number | string,
      loc,
    };
  }
  if (Array.isArray(tagged)) {
    return {
      kind: "array",
      items: tagged.map((x) => taggedToNode(x, loc)),
      loc,
    };
  }
  const fields: FieldIR[] = Object.entries(tagged).map(([name, v]) => ({
    name,
    value: taggedToNode(v, loc),
    loc,
  }));
  return { kind: "object", fields, loc };
}

/** 带 $ref 标记的结构 > vjson 表达式字符串 */
export function decompileTagged(tagged: TaggedValue): string {
  return decompileNode(taggedToNode(tagged));
}
