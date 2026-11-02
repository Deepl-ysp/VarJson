import path from "node:path";

export type VjsonErrorType =
  | "Path Error"
  | "Cycle Error"
  | "Reference Error"
  | "Type Error"
  | "Index Error"
  | "Syntax Error";

export type ImportChainItem = { fileIndex: number; line: number; col: number };

export type VjsonError = {
  type: VjsonErrorType;
  message: string;
  fileIndex?: number;
  line?: number;
  col?: number;
  importChain?: ImportChainItem[];
};

export type VjsonEvalErrorType =
  | "Reference Error"
  | "Type Error"
  | "Index Error"
  | "Cycle Error";

export type VjsonEvalError = {
  type: VjsonEvalErrorType;
  message: string;
  fileIndex: number;
  line: number;
  col: number;
};

export type Token = {
  kind: "ident" | "string" | "number" | "punct";
  value: string;
  line: number;
  col: number;
  depth: number;
};

export type ImportRef = {
  raw: string;
  alias: string;
  line: number;
  col: number;
  absPath?: string;
  fileIndex?: number;
};

export type ScopeDef = { name: string; line: number; col: number };

export type Loc = { fileIndex: number; line: number; col: number };

export type PathSegment =
  | { kind: "field"; name: string }
  | { kind: "index"; value: number };

export type LiteralNode = {
  kind: "literal";
  value: number | string | boolean | null;
  loc: Loc;
};

export type ArrayNode = { kind: "array"; items: NodeIR[]; loc: Loc };
export type ObjectNode = { kind: "object"; fields: FieldIR[]; loc: Loc };

/**
 * 引用符号。语义见 README §3.4 / §3.9 / §3.11：
 *
 *   base.kind = "local" > 裸标识符：仅当前作用域已定义字段
 *   base.kind = "scope" > 本模块显式作用域（tops/var/自定义）
 *   base.kind = "alias" > 跨模块别名
 *
 *   bang = false > 默认作用域（本模块 scope 名当作 tops 下字段；跨模块用 dep.tops）
 *   bang = true > 明确顶级作用域
 */
export type RefNode = {
  kind: "ref";
  base:
    | { kind: "local" }
    | { kind: "scope"; name: string }
    | { kind: "alias"; name: string };
  bang: boolean;
  path: PathSegment[];
  loc: Loc;
};

export type NodeIR = LiteralNode | ArrayNode | ObjectNode | RefNode;

export type FieldIR = {
  name: string;
  value: NodeIR;
  loc: Loc;
};

export type ScopeIR = {
  name: string;
  kind: "tops" | "var" | "custom";
  fields: FieldIR[];
  loc: Loc;
};

export type ModuleIR = {
  fileIndex: number;
  path: string;
  imports: ImportRef[];
  scopes: Map<string, ScopeIR>;
  scopeOrder: string[];
};

export type ModuleInfo = {
  fileIndex: number;
  path: string;
  events: Token[];
  imports: ImportRef[];
  aliases: Map<string, number>;
  topScopes: Set<string>;
  scopeDefs: ScopeDef[];
  ir?: ModuleIR;
};

export type ModuleValues = {
  scopes: Map<string, Map<string, unknown>>;
};

export function toAbs(p: string, baseDir?: string): string {
  const base = baseDir ?? (import.meta as any).dirname ?? process.cwd();
  const abs = path.isAbsolute(p) ? p : path.resolve(base, p);
  return abs.replaceAll("\\", "/");
}

export function parseNumberLiteral(raw: string): number | undefined {
  const clean = raw.replace(/[_,]/g, "");
  if (/^0[bB]/.test(clean)) {
    const v = parseInt(clean.slice(2), 2);
    return isNaN(v) ? undefined : v;
  }
  if (/^0[oO]/.test(clean)) {
    const v = parseInt(clean.slice(2), 8);
    return isNaN(v) ? undefined : v;
  }
  if (/^0[xX]/.test(clean)) {
    const v = parseInt(clean.slice(2), 16);
    return isNaN(v) ? undefined : v;
  }
  const v = parseFloat(clean);
  return isNaN(v) ? undefined : v;
}

export function unescapeString(raw: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "\\") {
      out.push(ch);
      i++;
      continue;
    }
    const next = raw[i + 1];
    switch (next) {
      case "n":
        out.push("\n");
        i += 2;
        break;
      case "t":
        out.push("\t");
        i += 2;
        break;
      case "r":
        out.push("\r");
        i += 2;
        break;
      case '"':
        out.push('"');
        i += 2;
        break;
      case "\\":
        out.push("\\");
        i += 2;
        break;
      case "/":
        out.push("/");
        i += 2;
        break;
      case "b":
        out.push("\b");
        i += 2;
        break;
      case "f":
        out.push("\f");
        i += 2;
        break;
      case "u":
        if (i + 5 < raw.length) {
          const hex = raw.slice(i + 2, i + 6);
          const code = parseInt(hex, 16);
          if (!isNaN(code)) {
            out.push(String.fromCharCode(code));
            i += 6;
            break;
          }
        }
        out.push("\\u");
        i += 2;
        break;
      default:
        out.push("\\" + (next ?? ""));
        i += 2;
    }
  }
  return out.join("");
}

/** 深拷贝（纯 JSON 数据模型：object / array / 原始值） */
export function deepClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepClone(v);
  }
  return out;
}

export function formatError(
  err: VjsonError,
  fileList: { path: string }[],
): string {
  const lines = [`[${err.type}] ${err.message}`];
  if (
    (err.type === "Path Error" || err.type === "Cycle Error") &&
    err.importChain
  ) {
    for (const c of err.importChain) {
      const file = fileList[c.fileIndex]?.path ?? "<unknown>";
      // 内部 0-based，输出给人看时 +1 行号
      lines.push(`  imported from ${file} ${c.line + 1}:${c.col}`);
    }
  } else if (
    err.fileIndex !== undefined &&
    err.line !== undefined &&
    err.col !== undefined
  ) {
    const file = fileList[err.fileIndex]?.path ?? "<unknown>";
    lines.push(`  at ${file} ${err.line + 1}:${err.col}`);
  }
  return lines.join("\n");
}

export function formatErrors(
  list: VjsonError[],
  fileList: { path: string }[],
  max = 100,
): string {
  const shown = list.slice(0, max).map((e) => formatError(e, fileList));
  if (list.length > max) {
    shown.push(
      `[Path Error] Too many errors (>= ${max}). Full log written to: ./error.log`,
    );
  }
  return shown.join("\n\n");
}

export function formatEvalErrors(
  errors: VjsonEvalError[],
  moduleList: ModuleInfo[],
  max = 100,
): string {
  const shown = errors.slice(0, max).map((err) => {
    const file = moduleList[err.fileIndex]?.path ?? "<unknown>";
    return `[${err.type}] ${err.message}\n  at ${file} ${err.line + 1}:${err.col}`;
  });
  if (errors.length > max) {
    shown.push(
      `[Path Error] Too many errors (>= ${max}). Full log written to: ./error.log`,
    );
  }
  return shown.join("\n\n");
}
