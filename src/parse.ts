import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type Token,
  type ImportRef,
  type ScopeDef,
  type Loc,
  type PathSegment,
  type NodeIR,
  type FieldIR,
  type ScopeIR,
  type ModuleIR,
  type ModuleInfo,
  type VjsonError,
  type ImportChainItem,
  toAbs,
  parseNumberLiteral,
  unescapeString,
  formatErrors,
} from "./common.ts";

export class ParseSession {
  currentIndex = 0;
  fileList: { path: string; data: string; fileIndex: number }[] = [];
  astList: unknown[] = [];
  irList: (ModuleIR | undefined)[] = [];
  moduleList: ModuleInfo[] = [];
  importCache = new Map<string, number>();
  errors: VjsonError[] = [];
  loadingSet = new Set<string>();

  scanTopLevel(text: string): Token[] {
    const events: Token[] = [];
    const n = text.length;
    let i = 0,
      line = 0,
      col = 0,
      depth = 0;

    const advance = (count = 1) => {
      for (let k = 0; k < count && i < n; k++) {
        if (text[i] === "\n") {
          line++;
          col = 0;
        } else {
          col++;
        }
        i++;
      }
    };

    while (i < n) {
      const ch = text[i];

      if (ch === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") advance();
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        advance(2);
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) advance();
        if (i < n) advance(2);
        continue;
      }
      if (/\s/.test(ch)) {
        advance();
        continue;
      }

      if (ch === '"') {
        const sl = line,
          sc = col;
        advance();
        let v = "";
        while (i < n && text[i] !== '"') {
          if (text[i] === "\\" && i + 1 < n) {
            v += text[i] + text[i + 1];
            advance(2);
          } else {
            v += text[i];
            advance();
          }
        }
        if (i < n) advance();
        events.push({ kind: "string", value: v, line: sl, col: sc, depth });
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        const sl = line,
          sc = col;
        let v = "";
        while (i < n && /[A-Za-z0-9_$]/.test(text[i])) {
          v += text[i];
          advance();
        }
        events.push({ kind: "ident", value: v, line: sl, col: sc, depth });
        continue;
      }

      if (/[0-9]/.test(ch)) {
        const sl = line,
          sc = col;
        let v = "";
        const isHexPrefixed = () => /^0[bBoOxX]/.test(v);
        while (i < n) {
          const c = text[i];
          if (/[0-9A-Za-z_]/.test(c)) {
            v += c;
            advance();
            continue;
          }
          if (
            (c === "." || c === ",") &&
            i + 1 < n &&
            /[0-9]/.test(text[i + 1])
          ) {
            v += c;
            advance();
            continue;
          }
          if ((c === "+" || c === "-") && /[eE]$/.test(v) && !isHexPrefixed()) {
            v += c;
            advance();
            continue;
          }
          break;
        }
        events.push({ kind: "number", value: v, line: sl, col: sc, depth });
        continue;
      }

      const sl = line,
        sc = col;
      if (ch === "{" || ch === "[" || ch === "(") {
        events.push({ kind: "punct", value: ch, line: sl, col: sc, depth });
        depth++;
        advance();
        continue;
      }
      if (ch === "}" || ch === "]" || ch === ")") {
        if (depth > 0) depth--;
        events.push({ kind: "punct", value: ch, line: sl, col: sc, depth });
        advance();
        continue;
      }

      events.push({ kind: "punct", value: ch, line: sl, col: sc, depth });
      advance();
    }

    return events;
  }

  extractImports(events: Token[], fileIndex: number): ImportRef[] {
    const imports: ImportRef[] = [];
    const top = events.filter((e) => e.depth === 0);
    let i = 0;
    while (i < top.length) {
      const e = top[i];
      if (e.kind === "ident" && e.value === "import") {
        const strEv = top[i + 1];
        if (!strEv || strEv.kind !== "string") {
          this.errors.push({
            type: "Syntax Error",
            message: "Import statement requires a path string",
            fileIndex,
            line: e.line,
            col: e.col,
          });
          i += 1;
          continue;
        }
        const asEv = top[i + 2];
        const aliasEv = top[i + 3];
        if (
          !asEv ||
          asEv.kind !== "ident" ||
          asEv.value !== "as" ||
          !aliasEv ||
          aliasEv.kind !== "ident"
        ) {
          this.errors.push({
            type: "Syntax Error",
            message: "Import statement requires an alias",
            fileIndex,
            line: e.line,
            col: e.col,
          });
          i += 1;
          continue;
        }
        imports.push({
          raw: strEv.value,
          alias: aliasEv.value,
          line: e.line,
          col: e.col,
        });
        i += 4;
        continue;
      }
      i += 1;
    }
    return imports;
  }

  extractTopScopes(events: Token[]): ScopeDef[] {
    const defs: ScopeDef[] = [];
    const top = events.filter((e) => e.depth === 0);
    let i = 0;
    while (i < top.length) {
      const e = top[i];
      if (e.kind === "ident" && e.value !== "import") {
        const eq = top[i + 1];
        const lb = top[i + 2];
        if (
          eq &&
          eq.kind === "punct" &&
          eq.value === "=" &&
          lb &&
          lb.kind === "punct" &&
          lb.value === "{"
        ) {
          defs.push({ name: e.value, line: e.line, col: e.col });
          i += 3;
          continue;
        }
      }
      i += 1;
    }
    return defs;
  }

  checkBangRefs(
    events: Token[],
    mod: {
      fileIndex: number;
      topScopes: Set<string>;
      aliases: Map<string, number>;
      importChain: ImportChainItem[];
    },
  ) {
    const { fileIndex, topScopes, aliases, importChain } = mod;

    for (let idx = 0; idx < events.length; idx++) {
      const e = events[idx];
      if (e.kind !== "punct") continue;

      if (e.value === "&") {
        const nextTok = events[idx + 1];
        if (nextTok && nextTok.kind === "punct" && nextTok.value === "&") {
          idx++;
          continue;
        }
        const base = e.depth;
        for (let j = idx + 1; j < events.length; j++) {
          const t = events[j];
          if (t.depth < base) break;
          if (t.depth === base) {
            if (
              t.kind === "punct" &&
              (t.value === "," ||
                t.value === "}" ||
                t.value === ";" ||
                t.value === "=" ||
                t.value === "{")
            )
              break;
            if (t.kind === "punct" && t.value === "&") {
              this.errors.push({
                type: "Syntax Error",
                message: "'&' cannot be chained",
                fileIndex,
                line: t.line,
                col: t.col,
                importChain,
              });
              break;
            }
          }
        }
        continue;
      }

      if (e.value !== "!") continue;
      const nxt = events[idx + 1];
      if (nxt && nxt.kind === "punct" && nxt.value === "=") continue;

      const prev = events[idx - 1];

      if (
        (prev && prev.kind === "punct" && prev.value === "!") ||
        (nxt && nxt.kind === "punct" && nxt.value === "!")
      ) {
        this.errors.push({
          type: "Syntax Error",
          message: "'!' cannot be nested",
          fileIndex,
          line: e.line,
          col: e.col,
          importChain,
        });
        continue;
      }

      if (!nxt || nxt.kind !== "ident") {
        this.errors.push({
          type: "Syntax Error",
          message: "'!' must be followed by a top-level scope name",
          fileIndex,
          line: e.line,
          col: e.col,
          importChain,
        });
        continue;
      }

      const name = nxt.value;

      if (prev && prev.kind === "punct" && prev.value === "&") {
        if (aliases.has(name)) {
          this.errors.push({
            type: "Syntax Error",
            message: "'!' cannot be used to reference an alias",
            fileIndex,
            line: e.line,
            col: e.col,
            importChain,
          });
        } else if (!topScopes.has(name)) {
          this.errors.push({
            type: "Syntax Error",
            message: `Top-level scope '${name}' does not exist in current module`,
            fileIndex,
            line: e.line,
            col: e.col,
            importChain,
          });
        }
        continue;
      }

      if (prev && prev.kind === "punct" && prev.value === ".") {
        const head = events[idx - 2];
        if (!head || head.kind !== "ident") {
          this.errors.push({
            type: "Syntax Error",
            message: "'!' can only be used to determine a top-level scope",
            fileIndex,
            line: e.line,
            col: e.col,
            importChain,
          });
          continue;
        }
        if (!aliases.has(head.value)) {
          this.errors.push({
            type: "Syntax Error",
            message: "'!' can only follow '&' or an alias",
            fileIndex,
            line: e.line,
            col: e.col,
            importChain,
          });
          continue;
        }
        const dep = this.moduleList[aliases.get(head.value)!];
        if (!dep || !dep.topScopes.has(name)) {
          this.errors.push({
            type: "Syntax Error",
            message: `Top-level scope '${name}' does not exist in module '${head.value}'`,
            fileIndex,
            line: e.line,
            col: e.col,
            importChain,
          });
        }
        continue;
      }

      this.errors.push({
        type: "Syntax Error",
        message: "'!' can only be used to determine a top-level scope",
        fileIndex,
        line: e.line,
        col: e.col,
        importChain,
      });
    }
  }

  // 运算符检测（README §5.1 / §12.9：解析阶段直接 Syntax Error）
  checkOperators(
    events: Token[],
    fileIndex: number,
    importChain: ImportChainItem[],
  ) {
    const isExprEnd = (t: Token | undefined): boolean => {
      if (!t) return false;
      if (t.kind === "number" || t.kind === "string" || t.kind === "ident")
        return true;
      if (
        t.kind === "punct" &&
        (t.value === ")" || t.value === "]" || t.value === "}")
      )
        return true;
      return false;
    };

    const push = (line: number, col: number) => {
      this.errors.push({
        type: "Syntax Error",
        message: "Operators are not supported",
        fileIndex,
        line,
        col,
        importChain,
      });
    };

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.kind !== "punct") continue;
      const prev = events[i - 1];
      const next = events[i + 1];

      switch (e.value) {
        case "+":
          push(e.line, e.col);
          break;
        case "-":
          if (!isExprEnd(prev) && next && next.kind === "number") break; // 负数前缀
          push(e.line, e.col);
          break;
        case "*":
        case "/":
        case "%":
        case "<":
        case ">":
        case "?":
        case ":":
        case "^":
        case "~":
        case "|":
          push(e.line, e.col);
          break;
        case "=":
          if (next && next.kind === "punct" && next.value === "=") {
            push(e.line, e.col);
            i++;
          }
          break;
        case "&":
          if (next && next.kind === "punct" && next.value === "&") {
            push(e.line, e.col);
            i++;
          }
          break;
        case "!":
          if (next && next.kind === "punct" && next.value === "=") {
            push(e.line, e.col);
            i++;
          }
          break;
      }
    }
  }

  buildIR(
    events: Token[],
    fileIndex: number,
    absPath: string,
    imports: ImportRef[],
    aliases: Map<string, number>,
  ): ModuleIR | null {
    const ir: ModuleIR = {
      fileIndex,
      path: absPath,
      imports,
      scopes: new Map(),
      scopeOrder: [],
    };

    const parser = new ExprParser(events, fileIndex, aliases, this.errors);
    let i = 0;

    while (i < events.length) {
      const e = events[i];

      if (e.depth !== 0) {
        i++;
        continue;
      }

      if (e.kind === "ident" && e.value === "import") {
        i++;
        while (
          i < events.length &&
          !(events[i].kind === "punct" && events[i].value === ";")
        )
          i++;
        if (i < events.length) i++;
        continue;
      }

      if (e.kind === "ident") {
        const eq = events[i + 1];
        const lb = events[i + 2];
        if (
          !eq ||
          eq.kind !== "punct" ||
          eq.value !== "=" ||
          !lb ||
          lb.kind !== "punct" ||
          lb.value !== "{"
        ) {
          i++;
          continue;
        }

        const r = parser.parseObject(i + 2);
        if (!r) {
          this.errors.push({
            type: "Syntax Error",
            message: `Failed to parse scope body for '${e.value}'`,
            fileIndex,
            line: e.line,
            col: e.col,
          });
          i++;
          continue;
        }

        const kind: ScopeIR["kind"] =
          e.value === "tops" ? "tops" : e.value === "var" ? "var" : "custom";

        if (!ir.scopes.has(e.value)) {
          ir.scopes.set(e.value, {
            name: e.value,
            kind,
            fields: r.node.fields,
            loc: { fileIndex, line: e.line, col: e.col },
          });
          ir.scopeOrder.push(e.value);
        }

        i = r.next;
        continue;
      }

      i++;
    }

    return ir;
  }

  async loadModule(
    absPath: string,
    isEntry = false,
    importChain: ImportChainItem[] = [],
  ): Promise<number> {
    if (this.importCache.has(absPath)) return this.importCache.get(absPath)!;

    if (this.loadingSet.has(absPath)) {
      this.errors.push({
        type: "Cycle Error",
        message: `Circular import detected: ${absPath}`,
        importChain,
      });
      return -1;
    }
    this.loadingSet.add(absPath);

    let data: string;
    try {
      data = await readFile(absPath, "utf-8");
    } catch {
      if (isEntry) {
        this.loadingSet.delete(absPath);
        throw new Error(`[Path Error] No file found at this path: ${absPath}`);
      }
      this.errors.push({
        type: "Path Error",
        message: `No file found at this path: ${absPath}`,
        importChain,
      });
      this.loadingSet.delete(absPath);
      return -1;
    }

    const fileIndex = this.currentIndex++;
    this.fileList[fileIndex] = { path: absPath, data, fileIndex };

    const events = this.scanTopLevel(data);
    const imports = this.extractImports(events, fileIndex);
    const scopeDefs = this.extractTopScopes(events);

    const scopePos = new Map<string, ScopeDef>();
    for (const def of scopeDefs) {
      if (scopePos.has(def.name)) {
        this.errors.push({
          type: "Syntax Error",
          message: `Duplicate scope or alias: ${def.name}`,
          fileIndex,
          line: def.line,
          col: def.col,
          importChain,
        });
      } else {
        scopePos.set(def.name, def);
      }
    }

    const topScopes = new Set<string>(["tops", "var", ...scopePos.keys()]);
    const aliases = new Map<string, number>();
    const baseDir = path.dirname(absPath);

    for (const imp of imports) {
      if (aliases.has(imp.alias)) {
        this.errors.push({
          type: "Syntax Error",
          message: `Duplicate scope or alias: ${imp.alias}`,
          fileIndex,
          line: imp.line,
          col: imp.col,
          importChain,
        });
        continue;
      }
      if (
        scopePos.has(imp.alias) ||
        imp.alias === "tops" ||
        imp.alias === "var"
      ) {
        this.errors.push({
          type: "Syntax Error",
          message: `Duplicate scope or alias: ${imp.alias}`,
          fileIndex,
          line: imp.line,
          col: imp.col,
          importChain,
        });
        continue;
      }

      const depAbs = path.isAbsolute(imp.raw)
        ? imp.raw.replaceAll("\\", "/")
        : path.resolve(baseDir, imp.raw).replaceAll("\\", "/");
      imp.absPath = depAbs;

      const childChain: ImportChainItem[] = [
        { fileIndex, line: imp.line, col: imp.col },
        ...importChain,
      ];
      const depIndex = await this.loadModule(depAbs, false, childChain);
      if (depIndex >= 0) {
        aliases.set(imp.alias, depIndex);
        imp.fileIndex = depIndex;
      }
    }

    this.checkBangRefs(events, { fileIndex, topScopes, aliases, importChain });
    this.checkOperators(events, fileIndex, importChain);

    const ir = this.buildIR(events, fileIndex, absPath, imports, aliases);
    this.irList[fileIndex] = ir ?? undefined;

    const modInfo: ModuleInfo = {
      fileIndex,
      path: absPath,
      events,
      imports,
      aliases,
      topScopes,
      scopeDefs,
      ir: ir ?? undefined,
    };
    this.moduleList[fileIndex] = modInfo;
    this.astList[fileIndex] = {
      imports,
      topScopes: [...topScopes],
      scopeDefs,
      ir,
    };

    this.importCache.set(absPath, fileIndex);
    this.loadingSet.delete(absPath);
    return fileIndex;
  }
}

class ExprParser {
  private events: Token[];
  private fileIndex: number;
  private aliases: Map<string, number>;
  private errors: VjsonError[];

  constructor(
    events: Token[],
    fileIndex: number,
    aliases: Map<string, number>,
    errors: VjsonError[],
  ) {
    this.events = events;
    this.fileIndex = fileIndex;
    this.aliases = aliases;
    this.errors = errors;
  }

  private loc(t: Token): Loc {
    return { fileIndex: this.fileIndex, line: t.line, col: t.col };
  }

  private syntax(msg: string, t: Token) {
    this.errors.push({
      type: "Syntax Error",
      message: msg,
      fileIndex: this.fileIndex,
      line: t.line,
      col: t.col,
    });
  }

  /** 解析一个值：字面量 / 数组 / 对象 / 引用 */
  parseValue(start: number): { node: NodeIR; next: number } | null {
    const e = this.events[start];
    if (!e) return null;

    if (e.kind === "punct" && e.value === "-") {
      const next = this.events[start + 1];
      if (next && next.kind === "number") {
        const v = parseNumberLiteral(next.value);
        if (v !== undefined) {
          return {
            node: { kind: "literal", value: -v, loc: this.loc(e) },
            next: start + 2,
          };
        }
      }
      return null;
    }

    if (e.kind === "number") {
      const v = parseNumberLiteral(e.value);
      if (v === undefined) {
        this.syntax(`Invalid number literal: ${e.value}`, e);
        return null;
      }
      return {
        node: { kind: "literal", value: v, loc: this.loc(e) },
        next: start + 1,
      };
    }

    if (e.kind === "string") {
      return {
        node: {
          kind: "literal",
          value: unescapeString(e.value),
          loc: this.loc(e),
        },
        next: start + 1,
      };
    }

    if (e.kind === "ident") {
      if (e.value === "true")
        return {
          node: { kind: "literal", value: true, loc: this.loc(e) },
          next: start + 1,
        };
      if (e.value === "false")
        return {
          node: { kind: "literal", value: false, loc: this.loc(e) },
          next: start + 1,
        };
      if (e.value === "null")
        return {
          node: { kind: "literal", value: null, loc: this.loc(e) },
          next: start + 1,
        };
      return this.parseRef(start, false);
    }

    if (e.kind === "punct") {
      if (e.value === "[") return this.parseArray(start);
      if (e.value === "{") return this.parseObject(start);
      if (e.value === "&") return this.parseRef(start, true);
    }

    return null;
  }

  parseArray(start: number): { node: ArrayNode; next: number } | null {
    const open = this.events[start];
    if (!open || open.kind !== "punct" || open.value !== "[") return null;

    const items: NodeIR[] = [];
    let i = start + 1;

    while (i < this.events.length) {
      const e = this.events[i];

      if (e.kind === "punct" && e.value === "]") {
        return {
          node: { kind: "array", items, loc: this.loc(open) },
          next: i + 1,
        };
      }

      const r = this.parseValue(i);
      if (!r) {
        this.syntax("Invalid array element", e);
        i++;
        continue;
      }
      items.push(r.node);
      i = r.next;

      if (
        this.events[i] &&
        this.events[i].kind === "punct" &&
        this.events[i].value === ","
      ) {
        i++;
      }
    }

    this.syntax("Unclosed array", open);
    return null;
  }

  /**
   * 解析对象 { k = v, ... }
   * README §7.5：同作用域重复字段 > Syntax Error
   */
  parseObject(start: number): { node: ObjectNode; next: number } | null {
    const open = this.events[start];
    if (!open || open.kind !== "punct" || open.value !== "{") return null;

    const fields: FieldIR[] = [];
    const seen = new Set<string>();
    let i = start + 1;

    while (i < this.events.length) {
      const e = this.events[i];

      if (e.kind === "punct" && e.value === "}") {
        return {
          node: { kind: "object", fields, loc: this.loc(open) },
          next: i + 1,
        };
      }

      if (e.kind === "ident") {
        const eq = this.events[i + 1];
        if (!eq || eq.kind !== "punct" || eq.value !== "=") {
          i++;
          continue;
        }

        if (seen.has(e.value)) {
          this.syntax(`Duplicate field in same scope: ${e.value}`, e);
          // 仍尝试解析右侧以推进游标，但不加入 fields
          const rSkip = this.parseValue(i + 2);
          i = rSkip ? rSkip.next : i + 2;
          if (
            this.events[i] &&
            this.events[i].kind === "punct" &&
            this.events[i].value === ","
          )
            i++;
          continue;
        }
        seen.add(e.value);

        const r = this.parseValue(i + 2);
        if (!r) {
          this.syntax(`Invalid value for field '${e.value}'`, e);
          i++;
          continue;
        }

        fields.push({ name: e.value, value: r.node, loc: this.loc(e) });
        i = r.next;

        if (
          this.events[i] &&
          this.events[i].kind === "punct" &&
          this.events[i].value === ","
        ) {
          i++;
        }
        continue;
      }

      i++;
    }

    this.syntax("Unclosed object", open);
    return null;
  }

  /**
   * 解析引用。产出 RefNode，不求值。
   * 语法：ident | ident.path | &ident | &!scope | &alias.!scope 等
   */
  parseRef(
    start: number,
    hasAmp: boolean,
  ): { node: RefNode; next: number } | null {
    let i = start;
    let base: RefNode["base"];
    let bang = false;
    const path: PathSegment[] = [];

    if (hasAmp) {
      i++;
      const next = this.events[i];
      if (!next) return null;

      if (next.kind === "punct" && next.value === "!") {
        bang = true;
        i++;
        const name = this.events[i];
        if (!name || name.kind !== "ident") return null;
        base = { kind: "scope", name: name.value };
        i++;
      } else if (next.kind === "ident") {
        base = this.aliases.has(next.value)
          ? { kind: "alias", name: next.value }
          : { kind: "scope", name: next.value };
        i++;
      } else {
        return null;
      }
    } else {
      const next = this.events[i];
      if (!next || next.kind !== "ident") return null;
      base = { kind: "local" };
      path.push({ kind: "field", name: next.value });
      i++;
    }

    while (i < this.events.length) {
      const e = this.events[i];

      if (e.kind === "punct" && e.value === "[") {
        i++;
        const idx = this.events[i];
        if (!idx || idx.kind !== "number") return null;
        const n = parseInt(idx.value, 10);
        if (isNaN(n)) return null;
        path.push({ kind: "index", value: n });
        i++;
        const close = this.events[i];
        if (!close || close.kind !== "punct" || close.value !== "]")
          return null;
        i++;
        continue;
      }

      if (e.kind === "punct" && e.value === ".") {
        i++;
        const seg = this.events[i];
        if (!seg) return null;

        if (seg.kind === "ident") {
          path.push({ kind: "field", name: seg.value });
          i++;
          continue;
        }

        if (seg.kind === "punct" && seg.value === "!") {
          if (base.kind !== "alias" || bang) return null;
          bang = true;
          i++;
          const name = this.events[i];
          if (!name || name.kind !== "ident") return null;
          path.push({ kind: "field", name: name.value });
          i++;
          continue;
        }

        return null;
      }

      break;
    }

    return {
      node: {
        kind: "ref",
        base,
        bang,
        path,
        loc: this.loc(this.events[start]),
      },
      next: i,
    };
  }
}

type ArrayNode = { kind: "array"; items: NodeIR[]; loc: Loc };
type ObjectNode = { kind: "object"; fields: FieldIR[]; loc: Loc };
type RefNode = {
  kind: "ref";
  base:
    | { kind: "local" }
    | { kind: "scope"; name: string }
    | { kind: "alias"; name: string };
  bang: boolean;
  path: PathSegment[];
  loc: Loc;
};

export async function loadModules(entryPath: string) {
  const session = new ParseSession();
  const abs = toAbs(entryPath);
  const entryIndex = await session.loadModule(abs, true);

  if (session.errors.length > 0) {
    throw new Error(formatErrors(session.errors, session.fileList));
  }

  return {
    entryIndex,
    fileList: session.fileList,
    moduleList: session.moduleList,
    astList: session.astList,
    irList: session.irList,
    session,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).replaceAll("\\", "/") ===
    path.resolve(import.meta.filename ?? "").replaceAll("\\", "/");

if (isMain) {
  const target = process.argv[2] ?? "./data.vjson";
  try {
    const result = await loadModules(target);
    const entry = result.moduleList[result.entryIndex];
    if (entry?.ir) {
      console.log("entry IR:");
      for (const [name, scope] of entry.ir.scopes) {
        console.log(`  ${name} (${scope.kind}) fields:`);
        for (const f of scope.fields) {
          console.log(
            `    ${f.name} = ${JSON.stringify(f.value, (k, v) => (k === "loc" ? undefined : v))}`,
          );
        }
      }
    } else {
      console.log(
        "parse ok. modules:",
        result.moduleList.map((m) => ({
          path: m.path,
          topScopes: [...m.topScopes],
        })),
      );
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
