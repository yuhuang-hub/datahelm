// 轻量 SQL 美化 / 压缩：词法扫描（保留字符串、引号标识符、注释），按子句断行缩进。
// 不依赖第三方库；解析失败时原样返回，绝不改动语义内容。
// v0927.52 增强：CASE/WHEN/ELSE/END 块状缩进（支持嵌套）、WHERE/HAVING/ON 条件里的
// AND/OR 独立断行 +1 缩进（BETWEEN…AND 的 AND 不断）、子查询括号保存/恢复条件上下文。

const KEYWORDS = new Set(
  ('SELECT,FROM,WHERE,INSERT,INTO,VALUES,UPDATE,SET,DELETE,CREATE,TABLE,VIEW,INDEX,DROP,ALTER,RENAME,ADD,' +
    'JOIN,LEFT,RIGHT,INNER,OUTER,FULL,CROSS,ON,USING,GROUP,BY,ORDER,HAVING,LIMIT,OFFSET,UNION,ALL,EXCEPT,INTERSECT,' +
    'AS,AND,OR,NOT,NULL,IS,IN,LIKE,ILIKE,BETWEEN,DISTINCT,CASE,WHEN,THEN,ELSE,END,EXISTS,ASC,DESC,WITH,RETURNING,ESCAPE,INTERVAL,OVER,PARTITION,' +
    'PRIMARY,KEY,FOREIGN,REFERENCES,DEFAULT,UNIQUE,CHECK,CONSTRAINT,AUTO_INCREMENT,IDENTITY,TOP,USE,SHOW,TRUNCATE,' +
    'COMMENT,COLLATE,ENGINE,CHARSET,DATABASE,SCHEMA,IF,CAST,COALESCE,NULLIF,CONCAT,SUBSTRING,TRIM,LENGTH,UPPER,LOWER')
    .split(',')
);

// 换行的子句起始词（在当前语句层级）
const CLAUSE_BREAKS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT',
  'SET', 'VALUES', 'RETURNING', 'WITH', 'USING',
]);
// JOIN 前导词：LEFT/RIGHT/… 后面（最多隔一个 OUTER）是 JOIN 才断行
const JOIN_LEADS = new Set(['LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS']);
// 这些关键字后的 "(" 保留空格（IN (…) / VALUES (…) …），其余视为函数调用不留空格（count(…)
const KEEP_SPACE_BEFORE_PAREN = new Set([
  'IN', 'VALUES', 'USING', 'ON', 'AND', 'OR', 'WHERE', 'THEN', 'ELSE', 'WHEN', 'LIKE', 'ILIKE', 'BETWEEN',
  'JOIN', 'SELECT', 'FROM', 'SET', 'ALL', 'DISTINCT', 'EXISTS', 'NOT', 'BY', 'WITH', 'AS', 'ANY', 'SOME',
  'RETURNING', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'IF', 'CASE', 'IS', 'NULL', 'INTO',
]);
// 这些关键字之后的 word 是表名，表名后的 "(" 是列清单而非函数调用
const TABLE_AFTER = new Set(['INTO', 'FROM', 'UPDATE', 'JOIN', 'TABLE', 'RENAME', 'TRUNCATE']);

// ---- 词法：token = { t: ws|lc|bc|str|word|punc, v } ----
function tokenize(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      let j = i;
      while (j < n && ' \t\r\n'.includes(s[j])) j += 1;
      out.push({ t: 'ws', v: s.slice(i, j) });
      i = j;
    } else if (c === '-' && s[i + 1] === '-') {
      let j = s.indexOf('\n', i);
      if (j === -1) j = n;
      out.push({ t: 'lc', v: s.slice(i, j) });
      i = j;
    } else if (c === '/' && s[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(s[j] === '*' && s[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      out.push({ t: 'bc', v: s.slice(i, j) });
      i = j;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\' && c !== '`') j += 2; // 反斜杠转义（MySQL/PG 标准 conforming off）
        else if (s[j] === c) {
          if (s[j + 1] === c) j += 2; // 双写转义
          else { j += 1; break; }
        } else j += 1;
      }
      out.push({ t: 'str', v: s.slice(i, Math.min(j, n)) });
      i = Math.min(j, n);
    } else if (/[A-Za-z0-9_$#]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$#]/.test(s[j])) j += 1;
      out.push({ t: 'word', v: s.slice(i, j) });
      i = j;
    } else if (c === '[') {
      // MSSQL 标识符
      let j = i + 1;
      while (j < n && s[j] !== ']') j += 1;
      j = Math.min(n, j + 1);
      out.push({ t: 'str', v: s.slice(i, j) });
      i = j;
    } else {
      // 运算符/标点：多字符运算符合并
      const two = s.slice(i, i + 2);
      const OPS = ['>=', '<=', '<>', '!=', '||', '+=', '-=', ':=', '::', '->'];
      if (OPS.includes(two)) {
        out.push({ t: 'punc', v: two });
        i += 2;
      } else {
        out.push({ t: 'punc', v: c });
        i += 1;
      }
    }
  }
  return out;
}

// ---- 美化 ----
export function formatSql(input) {
  const src = String(input == null ? '' : input);
  if (!src.trim()) return src;
  try {
    const toks = tokenize(src);
    const sig = toks.filter((t) => t.t !== 'ws');
    let out = '';
    let depth = 0;
    let lastSig = null; // 上一个已输出的显著 token
    let prevWordUp = null; // 上一个输出的 word（大写），用于 DELETE FROM / JOIN 连排判断
    let lineStart = true; // 当前行是否只有缩进
    let phase = null; // 'select'：处于 SELECT 列表（该层逗号断行）
    let clauseCtx = null; // 'where'：处于 WHERE/HAVING/ON 布尔条件（AND/OR 断行缩进）
    let betweenPending = 0; // BETWEEN…AND 的 AND 不参与断行（恰好消耗一次）
    const caseStack = []; // CASE 块：{ d: 进入 CASE 时的 depth }，WHEN/ELSE 起行、END 回缩
    const parenStack = []; // { sub: true|false }
    const indent = () => '  '.repeat(Math.max(0, depth));
    const newline = (extra = 0) => {
      out = out.replace(/[ \t]+$/, '');
      out += '\n' + '  '.repeat(Math.max(0, depth + extra));
      lineStart = true;
      lastSig = null;
    };
    const emit = (v) => {
      out += v;
      lineStart = false;
    };
    const nextSigWord = (idx) => {
      for (let k = idx + 1; k < sig.length; k += 1) {
        if (sig[k].t === 'word') return sig[k].v.toUpperCase();
        if (sig[k].t === 'punc' && sig[k].v !== '.') return null;
      }
      return null;
    };
    const nextNextSigWord = (idx) => {
      let seen = 0;
      for (let k = idx + 1; k < sig.length && seen < 2; k += 1) {
        if (sig[k].t === 'word') {
          seen += 1;
          if (seen === 2) return sig[k].v.toUpperCase();
        }
      }
      return null;
    };

    for (let idx = 0; idx < sig.length; idx += 1) {
      const tk = sig[idx];
      if (tk.t === 'lc') {
        if (!lineStart) out += ' ';
        emit(tk.v);
        newline();
        continue;
      }
      if (tk.t === 'bc') {
        if (!lineStart) out += ' ';
        emit(tk.v);
        out += ' ';
        lastSig = tk;
        continue;
      }
      if (tk.t === 'str') {
        if (lastSig && lastSig.v !== '(' && lastSig.v !== '.') out += ' ';
        emit(tk.v);
        lastSig = tk;
        continue;
      }
      if (tk.t === 'word') {
        const up = tk.v.toUpperCase();
        const isKw = KEYWORDS.has(up);
        const vw = isKw ? up : tk.v;
        // 语句层级 = 所有未闭合括号均为子查询括号（函数调用括号内不算）
        const atTop = parenStack.every((p) => p.sub);
        // CASE 块（v0927.52）：WHEN/ELSE 相对 CASE 缩进一行，END 回到 CASE 所在层收尾
        if ((up === 'WHEN' || up === 'ELSE') && caseStack.length) {
          newline();
          emit(vw);
          lastSig = tk;
          prevWordUp = up;
          continue;
        }
        if (up === 'END' && caseStack.length) {
          depth = caseStack.pop().d;
          newline();
          emit('END');
          lastSig = tk;
          prevWordUp = up;
          continue;
        }
        // AND/OR 断行（v0927.52）：仅 WHERE/HAVING/ON 条件里 +1 缩进；BETWEEN…AND 不断
        if ((up === 'AND' || up === 'OR') && atTop && clauseCtx === 'where') {
          const isBetweenAnd = up === 'AND' && betweenPending > 0;
          betweenPending = 0;
          if (!isBetweenAnd) {
            newline(1);
            emit(vw);
            lastSig = tk;
            prevWordUp = up;
            continue;
          }
        }
        let brk = false;
        if (atTop && CLAUSE_BREAKS.has(up) && up !== 'USING') brk = true;
        if (up === 'USING' && atTop) brk = true;
        if (up === 'JOIN' && atTop && !(prevWordUp && JOIN_LEADS.has(prevWordUp))) brk = true;
        if (up === 'FROM' && prevWordUp === 'DELETE') brk = false; // DELETE FROM 同行
        if (JOIN_LEADS.has(up) && atTop) {
          const n1 = nextSigWord(idx);
          if (n1 === 'JOIN' || (n1 === 'OUTER' && nextNextSigWord(idx) === 'JOIN')) brk = true;
        }
        if (up === 'ON' && atTop) {
          newline(1);
          emit(vw);
          lastSig = tk;
          prevWordUp = up;
          clauseCtx = 'where'; // ON 后的连接条件与 WHERE 同待遇：AND/OR 断行缩进
          continue;
        }
        if (brk && lastSig && lastSig.v !== '(') newline();
        else if (lastSig && lastSig.v !== '(' && lastSig.v !== '.') out += ' ';
        emit(vw);
        lastSig = tk;
        prevWordUp = up;
        if (up === 'CASE') {
          caseStack.push({ d: depth });
          depth += 1;
        }
        if (up === 'BETWEEN') betweenPending = 1;
        if (atTop && up === 'SELECT') {
          phase = 'select';
          clauseCtx = 'select';
        } else if (atTop && (up === 'WHERE' || up === 'HAVING')) {
          phase = null;
          clauseCtx = 'where';
        } else if (atTop && CLAUSE_BREAKS.has(up)) {
          phase = null;
          clauseCtx = null;
        }
        continue;
      }
      // punc
      const v = tk.v;
      if (v === '(') {
        const n1 = nextSigWord(idx);
        const sub = n1 === 'SELECT' || n1 === 'WITH';
        // 函数名后不加空格：count( / max( …；IN/VALUES/AND/逗号/表名(INSERT INTO t (a,b)) 后保留空格
        const afterTable = TABLE_AFTER.has(prevWordUp);
        const tight =
          lastSig && lastSig.t === 'word' && !afterTable && !KEEP_SPACE_BEFORE_PAREN.has(String(lastSig.v).toUpperCase());
        if (lastSig && !tight && lastSig.v !== '(' && lastSig.v !== '.') out += ' ';
        emit('(');
        parenStack.push({ sub, phase, ctx: clauseCtx });
        betweenPending = 0;
        if (sub) {
          depth += 1;
          newline();
        }
        lastSig = sub ? null : tk;
      } else if (v === ')') {
        const p = parenStack.pop();
        if (p && p.sub) {
          depth -= 1;
          newline();
        }
        if (p) {
          phase = p.phase;
          clauseCtx = p.ctx; // 恢复进入子查询前的条件上下文（外层 AND/OR 继续断行）
        }
        betweenPending = 0;
        emit(')');
        lastSig = tk;
      } else if (v === ',') {
        emit(',');
        betweenPending = 0;
        if (phase === 'select' && parenStack.every((x) => x.sub)) {
          newline();
        } else {
          lastSig = tk;
        }
      } else if (v === ';') {
        emit(';');
        newline();
        out += '\n'; // 语句间空一行
        phase = null;
        clauseCtx = null;
        prevWordUp = null;
      } else if (v === '.') {
        emit('.');
        lastSig = tk;
      } else {
        // 运算符等
        if (lastSig && lastSig.v !== '(') out += ' ';
        emit(v);
        lastSig = tk;
      }
    }
    return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  } catch {
    return src;
  }
}

// ---- 压缩：去注释、空白归一（保留字符串）----
export function minifySql(input) {
  const src = String(input == null ? '' : input);
  if (!src.trim()) return src;
  try {
    const toks = tokenize(src).filter((t) => t.t !== 'ws' && t.t !== 'lc' && t.t !== 'bc');
    let out = '';
    let prev = null;
    for (const tk of toks) {
      if (tk.t === 'word' || tk.t === 'str') {
        const needSpace =
          prev != null && ((prev.t === 'word' || prev.t === 'str') || (prev.t === 'punc' && prev.v === ')'));
        if (needSpace) out += ' ';
        out += tk.v;
      } else {
        out += tk.v;
      }
      prev = tk;
    }
    return out.replace(/\s+$/, '');
  } catch {
    return src;
  }
}
