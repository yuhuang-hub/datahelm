import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql, MySQL, PostgreSQL, StandardSQL } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion, snippetCompletion } from '@codemirror/autocomplete';
import { undo as cmUndo, redo as cmRedo, historyField } from '@codemirror/commands';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { loadCfg, subscribe } from '../completionStore';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL',
  'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT', 'INDEX', 'VIEW', 'TRUNCATE', 'WITH', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'EXISTS', 'ASC', 'DESC', 'USE', 'SHOW', 'DATABASE',
];

// 代码片段（v0927.44 起由补全设置面板管理，completionStore 持久化）：输入短前缀展开成完整骨架。
// 补全弹层打开时按最新配置现建选项；模板写坏时降级为纯文本插入，不让单个坏片段拖垮整个弹层
const snippetOpt = (s) => {
  try {
    return snippetCompletion(s.template, { label: s.label, type: 'keyword', detail: s.detail || (s.builtin ? '片段' : '片段·自定义') });
  } catch {
    return { label: s.label, type: 'keyword', detail: s.detail || '片段', apply: s.template };
  }
};

// 别名后紧跟的 SQL 保留词不是别名（FROM employees WHERE … 不能把 WHERE 当别名）
const ALIAS_STOP = new Set([
  'where', 'on', 'group', 'order', 'inner', 'left', 'right', 'full', 'cross', 'join', 'union', 'limit', 'offset',
  'having', 'set', 'values', 'as', 'by', 'and', 'or', 'not', 'use', 'with',
]);

// 解析一段 SQL 里 FROM/JOIN/UPDATE 引用的表与别名（` 为引用符时也识别）
const parseRefs = (stmt) => {
  const refs = [];
  const re = /\b(?:from|join|update)\s+["`[]?([\w$]+)["`\]]?(?:\s+(?:as\s+)?([\w$]+))?/gi;
  let m = re.exec(stmt);
  while (m) {
    const aliasRaw = m[2] || "";
    const alias = aliasRaw && !ALIAS_STOP.has(aliasRaw.toLowerCase()) ? aliasRaw : '';
    if (m[1]) refs.push({ table: m[1], alias });
    m = re.exec(stmt);
  }
  return refs;
};

// 当前光标所在语句（按分号切分后定位包含 pos 的段）
const stmtAround = (doc, pos) => {
  const full = doc.toString();
  let acc = 0;
  for (const seg of full.split(';')) {
    if (pos <= acc + seg.length) return seg;
    acc += seg.length + 1;
  }
  return full;
};


const SqlEditor = forwardRef(function SqlEditor(
  { value, onChange, onRun, onSave, dialect, dark, tables, fetchColumns, placeholder },
  ref
) {
  const viewRef = useRef(null);
  // onChange / basicSetup 必须是稳定引用：@uiw 的 reconfigure effect 把它们列为依赖，
  // 内联闭包/对象会让每次击键后的重渲染都重建 CodeMirror 扩展——history 状态随之被
  // 清空，Ctrl+Z 撤销就会失效（这也是此前撤销不可用的根因）
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const stableChange = useCallback((val, vu) => {
    if (onChangeRef.current) onChangeRef.current(val, vu);
  }, []);
  const basicSetup = useMemo(() => ({ foldGutter: false, autocompletion: false, highlightActiveLine: true }), []);
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const tablesRef = useRef(tables || []);
  tablesRef.current = tables || [];
  const fetchColsRef = useRef(fetchColumns);
  fetchColsRef.current = fetchColumns;
  const colCacheRef = useRef({});
  // 补全配置（片段/开关）：ref + 订阅更新，不进 state——extensions 只按 dialect 重建，
  // 配置变化不需要重渲染，弹层打开时从 ref 现读即可（撤销历史不受影响）
  const acCfgRef = useRef(null);
  if (acCfgRef.current == null) acCfgRef.current = loadCfg();
  useEffect(() => subscribe((cfg) => { acCfgRef.current = cfg; }), []);

  const completer = async (ctx) => {
    const pos = ctx.pos;
    const line = ctx.state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    const m = /([\w$]+(?:\.[\w$]+)?)$/.exec(before);
    if (!m) return null;
    const word = m[1];
    const refs = parseRefs(stmtAround(ctx.state.doc, pos));
    // 列缓存（小写表名键）：点后取列与列名上下文取列共用
    const colsOf = async (t) => {
      const key = String(t).toLowerCase();
      const cache = colCacheRef.current;
      if (!cache[key]) {
        try {
          cache[key] = (await fetchColsRef.current(t)) || [];
        } catch {
          cache[key] = [];
        }
      }
      return cache[key];
    };
    if (word.includes(".")) {
      // 限定列名：别名优先解析（FROM employees e → e. 给出 employees 的列），其次按表名
      const qual = word.split('.')[0].replace(/["`]/g, "");
      const hit = refs.find((r) => r.alias && r.alias.toLowerCase() === qual.toLowerCase())
        || refs.find((r) => r.table.toLowerCase() === qual.toLowerCase());
      const cols = await colsOf(hit ? hit.table : qual);
      return {
        from: pos - (word.length - word.indexOf(".") - 1),
        options: cols.map((c) => ({ label: c, type: 'property' })),
      };
    }
    // 上下文判定：当前词之前的文段末尾紧跟 FROM/JOIN/UPDATE/INTO → 表名位；
    // SELECT/WHERE/AND/OR/ON/SET/BY/HAVING/VALUES → 列名位（给 FROM 已引用表的列）
    const head = ctx.state.doc.sliceString(Math.max(0, pos - word.length - 96), pos - word.length).toLowerCase();
    const tableCtx = /(?:^|[^a-z_])(?:from|join|update|into)\s*$/.test(head);
    const colCtx = !tableCtx && /(?:^|[^a-z_])(?:select|where|and|or|on|set|by|having|values)\s*$/.test(head);
    let colOpts = [];
    if (colCtx && refs.length) {
      const seen = new Map();
      for (const r of refs) {
        for (const c of await colsOf(r.table)) {
          if (!seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
        }
      }
      // 列名优先于表名与关键字
      colOpts = [...seen.values()].map((c) => ({ label: c, type: 'property', boost: 99 }));
    }
    const cfg = acCfgRef.current || { keywordsOn: true, snippetsOn: true, snippets: [] };
    return {
      from: pos - word.length,
      validFor: /^[\w$]*$/,
      options: [
        ...colOpts,
        ...tablesRef.current.map((t) => ({ label: t, type: "type", boost: tableCtx ? 99 : -2 })),
        ...(cfg.keywordsOn ? KEYWORDS.map((k) => ({ label: k, type: 'keyword' })) : []),
        ...(cfg.snippetsOn ? cfg.snippets.map(snippetOpt) : []),
      ],
    };
  };

  const extensions = useMemo(() => {
    const lang = dialect === 'mysql' ? MySQL : dialect === 'postgres' ? PostgreSQL : StandardSQL;
    return [
      sql({ dialect: lang }),
      autocompletion({ override: [completer] }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              if (runRef.current) runRef.current();
              return true;
            },
          },
          // Ctrl+S 保存查询（未命名时弹保存弹窗，已保存过则直接快存）
          {
            key: 'Mod-s',
            run: () => {
              if (saveRef.current) saveRef.current();
              return true;
            },
          },
          // 显式绑定撤销/重做（basicSetup 自带 history 扩展，这里保证快捷键必定命中）
          { key: 'Mod-z', run: cmUndo },
          { key: 'Shift-Mod-z', run: cmRedo },
          { key: 'Mod-y', run: cmRedo },
        ])
      ),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialect]);

  useImperativeHandle(ref, () => ({
    getSelection: () => {
      const v = viewRef.current;
      if (!v) return '';
      const sel = v.state.selection.main;
      return v.state.sliceDoc(sel.from, sel.to);
    },
    getValue: () => {
      const v = viewRef.current;
      return v ? v.state.doc.toString() : '';
    },
    // 程序化整体替换文档：直接驱动 CodeMirror（@uiw 的 value 属性同步有 typingLatch，
    // 打字后约 1 秒内外部更新会被挂起延迟应用，导致“美化/清空/载入历史”看起来没生效）
    setValue: (text) => {
      const v = viewRef.current;
      if (!v) return;
      const t = String(text == null ? '' : text);
      if (t !== v.state.doc.toString()) {
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
      }
    },
    focusEditor: () => {
      if (viewRef.current) viewRef.current.focus();
    },
    undo: () => {
      const v = viewRef.current;
      if (v) cmUndo(v);
    },
    redo: () => {
      const v = viewRef.current;
      if (v) cmRedo(v);
    },
    canUndo: () => {
      const v = viewRef.current;
      if (!v) return false;
      const f = v.state.field(historyField, false);
      return !!f && f.done.length > 0;
    },
    canRedo: () => {
      const v = viewRef.current;
      if (!v) return false;
      const f = v.state.field(historyField, false);
      return !!f && f.undone.length > 0;
    },
    selectAll: () => {
      const v = viewRef.current;
      if (v) v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    },
    // 用文本替换当前选区（光标落在末尾），选区为空时即原位插入
    replaceSelection: (text) => {
      const v = viewRef.current;
      if (!v) return;
      const sel = v.state.selection.main;
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: String(text == null ? '' : text) },
        selection: { anchor: sel.from + String(text == null ? '' : text).length },
        scrollIntoView: true,
      });
    },
    // 选中行统一加/去 “-- ” 注释（全部已注释则去除，否则添加）
    toggleComment: () => {
      const v = viewRef.current;
      if (!v) return;
      const { state } = v;
      const changes = [];
      state.selection.ranges.forEach((range) => {
        const first = state.doc.lineAt(range.from);
        const last = state.doc.lineAt(range.to);
        let allCommented = true;
        for (let ln = first.number; ln <= last.number; ln++) {
          const text = state.doc.line(ln).text;
          if (text.trim() && !text.trimStart().startsWith('--')) {
            allCommented = false;
            break;
          }
        }
        for (let ln = first.number; ln <= last.number; ln++) {
          const line = state.doc.line(ln);
          if (!line.text.trim()) continue;
          if (allCommented) {
            const m = /--\s?/.exec(line.text);
            if (m) changes.push({ from: line.from + m.index, to: line.from + m.index + m[0].length, insert: '' });
          } else {
            const m = /^\s*/.exec(line.text);
            changes.push({ from: line.from + m[0].length, insert: '-- ' });
          }
        }
      });
      if (changes.length) v.dispatch({ changes });
    },
  }));

  return (
    <CodeMirror
      value={value}
      onChange={stableChange}
      extensions={extensions}
      theme={dark ? oneDark : 'light'}
      height="100%"
      placeholder={placeholder || '-- SQL 编辑器：Ctrl+Enter 运行，输入表名/列名/片段（ssf、sel、up…）自动补全'}
      basicSetup={basicSetup}
      onCreateEditor={(view) => {
        viewRef.current = view;
      }}
    />
  );
});

export default SqlEditor;
