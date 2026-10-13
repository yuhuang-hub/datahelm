import React, { useState } from 'react';

// ---- 执行计划解析：把 EXPLAIN 行集还原成算符树 ----
// sqlite EQP：列 [id, parent, notused, detail]，parent 指向父步骤 id（顶层为 0），兄弟按出现顺序；
// StmtText（mssql SHOWPLAN_TEXT）/ QUERY PLAN（postgres）：单列，算符行以 |-- 或 -> 前缀，按缩进层级栈式建树，
// 首个无前缀行是语句回显（根）；其余无前缀行（postgres 根算符/收尾统计）并入上一节点或成为新根；
// 其它方言（mysql 表格式 EXPLAIN）：扁平一节点一行。
const STMT_HEAD = /^(select|insert|update|delete|with|merge|declare|exec|execute|create|truncate|table|values)\b/i;

// sqlite 步骤短语 → 短算符标签（'SCAN employees' / 'SEARCH TABLE t' / 'USE TEMP B-TREE' …）
const sqliteOp = (d) => {
  const s = String(d || '');
  const w = s.split(/\s+/).filter(Boolean);
  const up = (w[0] || '').toUpperCase();
  const second = (w[1] || '').toUpperCase();
  const grab = (n) => w.slice(0, n).join(' ');
  if (up === 'SEARCH' || up === 'SCAN') return second === 'TABLE' || second === 'SUBQUERY' ? grab(3) : grab(2);
  if (up === 'USE' || up === 'CORRELATED') return grab(3);
  if (up === 'LIST' || up === 'SCALAR' || up === 'CO-ROUTINE') return grab(2);
  if (up === 'MATERIALIZE') return 'MATERIALIZE';
  return w[0] || s;
};

const mkNode = (key, op, detail) => ({ key, op: op || '算符', detail: String(detail || ''), children: [] });
const restAfter = (text, op) => (String(text || '').startsWith(op) ? String(text).slice(op.length).trim() : String(text || ''));

const parseSqliteTree = (columns, rows) => {
  if (!columns || columns.length < 4) return null;
  if (String(columns[0]).toLowerCase() !== 'id' || String(columns[1]).toLowerCase() !== 'parent') return null;
  const byId = new Map();
  const order = [];
  (rows || []).forEach((r, i) => {
    const detail = r[3] == null ? '' : String(r[3]);
    const op = sqliteOp(detail);
    const node = mkNode('s' + i, op, restAfter(detail, op));
    byId.set(Number(r[0]), node);
    order.push({ node, parent: Number(r[1]) });
  });
  if (!order.length) return null;
  const tops = [];
  order.forEach((o) => {
    const p = byId.get(o.parent);
    if (p && p !== o.node) p.children.push(o.node);
    else tops.push(o.node);
  });
  if (!tops.length) return null;
  // sqlite 顶层步骤可能是兄弟（SCAN + USE TEMP B-TREE）：统一挂到虚拟 QUERY PLAN 根，与 mssql 的语句根对齐
  const root = mkNode('sroot', 'QUERY PLAN', '');
  root.children = tops;
  return { format: 'sqlite', roots: [root] };
};

// 单列计划文本 → { marker, op, detail }：带 |-- / -> 前缀的是算符行，op 取首个 '(' 之前
const splitPlanLine = (text) => {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('|--') || trimmed.startsWith('->')) {
    const body = trimmed.startsWith('|--') ? trimmed.slice(3) : trimmed.slice(2);
    const cut = body.indexOf('(');
    const op = (cut > 0 ? body.slice(0, cut) : body).trim();
    return { marker: true, op: op || '算符', detail: cut > 0 ? body.slice(cut).trim() : '' };
  }
  if (STMT_HEAD.test(trimmed)) return { marker: false, op: '语句', detail: trimmed };
  const first = (trimmed.split(/\s+/)[0] || '').trim();
  return { marker: false, op: first || '行', detail: trimmed.slice(first.length).trim() };
};

const parseIndentTree = (columns, rows) => {
  if (!columns || columns.length !== 1) return null;
  const roots = [];
  const stack = []; // { ind, node }：缩进递减即出栈
  let stmt = null;
  let n = 0;
  (rows || []).forEach((r) => {
    const raw = r && r[0] != null ? String(r[0]) : '';
    if (!raw.trim()) return;
    const ind = raw.length - raw.replace(/^ +/, '').length;
    const info = splitPlanLine(raw);
    if (info.marker) {
      const node = mkNode('i' + n++, info.op, info.detail);
      while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].node : stmt;
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push({ ind, node });
      return;
    }
    if (!stmt && !stack.length && !roots.length) {
      stmt = mkNode('i' + n++, info.op, info.detail);
      roots.push(stmt);
      return;
    }
    if (stack.length) {
      // 缩进内的说明行（子计划名等）：并入上一算符
      const last = stack[stack.length - 1].node;
      last.detail = (last.detail + ' ' + info.op + ' ' + info.detail).trim();
    } else {
      const node = mkNode('i' + n++, info.op, info.detail);
      if (stmt) stmt.children.push(node);
      else roots.push(node);
    }
  });
  return roots.length ? { format: 'indent', roots } : null;
};

const parseFlat = (columns, rows) => {
  const nodes = (rows || []).map((r, i) => {
    const cells = (r || []).map((c) => (c == null ? '' : String(c)));
    return mkNode('f' + i, cells[0], cells.slice(1).join('  '));
  });
  return nodes.length ? { format: 'flat', roots: nodes } : null;
};

export const parsePlan = (columns, rows) => parseSqliteTree(columns, rows) || parseIndentTree(columns, rows) || parseFlat(columns, rows);

export const countPlanNodes = (roots) =>
  (roots || []).reduce((a, n) => a + 1 + countPlanNodes(n.children), 0);

const PlanNode = ({ node, depth }) => {
  const [open, setOpen] = useState(true);
  const branch = node.children.length > 0;
  return (
    <div className="plan-node">
      <div
        className={'plan-node-head' + (branch ? ' branch' : '')}
        style={{ paddingLeft: 6 + depth * 18 }}
        data-dh-op={node.op}
        title={node.op + (node.detail ? ' ' + node.detail : '')}
        onClick={() => { if (branch) setOpen(!open); }}
      >
        <span className="plan-toggle">{branch ? (open ? '▾' : '▸') : '·'}</span>
        <span className="plan-op">{node.op}</span>
        {node.detail ? <span className="plan-detail">{node.detail}</span> : null}
        {branch ? <span className="plan-kids">{node.children.length} 子级</span> : null}
      </div>
      {branch && open ? (
        <div className="plan-children">{node.children.map((c) => <PlanNode key={c.key} node={c} depth={depth + 1} />)}</div>
      ) : null}
    </div>
  );
};

export default function PlanTree({ roots }) {
  return (
    <div className="plan-tree">
      {roots.map((n) => <PlanNode key={n.key} node={n} depth={0} />)}
    </div>
  );
}
