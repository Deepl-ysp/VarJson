/**
 * 兼容层：evaluate > stringify
 * 新代码请直接 import { stringify } from "./stringify.ts"
 */
export {
  stringify,
  stringifyToJson,
  stringifyWithDebug,
  evaluate,
  evaluateWithDebug,
  EvalContext,
} from "./stringify.ts";
