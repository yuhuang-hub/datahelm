import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, message, Select, Tabs } from 'antd';
import { SaveOutlined, CaretRightOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import ResultGrid from '../ResultGrid';
import { dbApi } from '../../api';

// 方言标识符引号（mysql 反引号 / mssql 方括号 / 其余双引号）——仅用于 SELECT 生成
function qi(d, n) {
  const s = String(n || '');
  if (d === 'mysql' || d === 'mariadb') return '`' + s.replace(/`/g, '``') + '`';
  if (d === 'mssql') return '[' + s.replace(/]/g, ']]') + ']';
  return '"' + s.replace(/"/g, '""') + '"';
}
// 表的限定名：mysql 带库名，pg/mssql/oracle 带 schema
function qualName(d, db, schema, t) {
  if (d === 'mysql' || d === 'mariadb') return db ? `${qi(d, db)}.${qi(d, t)}` : qi(d, t);
  if (d === 'mssql') return (schema ? qi(d, schema) + '.' : '') + qi(d, t);
  if (d === 'oracle') return (schema ? schema + '.' : '') + qi(d, t);
  return (schema ? qi(d, schema) + '.' : '') + qi(d, t);
}

let joinSeq = 1;

// ---- SELECT 生成：设计状态 → 查询语句 ----
function genSelect(d, db, schema, st) {
  const { tbls, joins, whereText, orderText, distinct } = st;
  const multi = tbls.length > 1;
  const used = new Set();
  const sel = [];
  for (const t of tbls) {
    for (const c of t.cols) {
      if (!c.checked) continue;
      const out0 = c.out || c.name;
      let out = out0;
      let i = 2;
      while (used.has(out)) out = out0 + '_' + i++;
      used.add(out);
      sel.push(multi ? `${t.alias}.${qi(d, c.name)} AS ${qi(d, out)}` : qi(d, c.name));
    }
  }
  if (!sel.length) sel.push('*');
  const parts = [`SELECT${distinct ? ' DISTINCT' : ''} ${sel.join(',\n  ')}`];
  const from = [];
  if (tbls.length) from.push(`${qualName(d, db, schema, tbls[0].name)}${multi ? ' ' + tbls[0].alias : ''}`);
  for (let i = 1; i < tbls.length; i += 1) {
    const t = tbls[i];
    const js = joins.filter((j) => j.right === t.name && j.on.trim());
    if (js.length) {
      for (const j of js) from.push(`${j.type === 'LEFT' ? 'LEFT' : 'INNER'} JOIN ${qualName(d, db, schema, t.name)} ${t.alias} ON ${j.on.trim()}`);
    } else {
      from.push(`CROSS JOIN ${qualName(d, db, schema, t.name)} ${t.alias}`);
    }
  }
  if (from.length) parts.push('FROM ' + from.join('\n  '));
  if (whereText.trim()) parts.push('WHERE ' + whereText.trim());
  if (orderText.trim()) parts.push('ORDER BY ' + orderText.trim());
  return parts.join('\n');
}

// ---- 已有视图 DDL → 设计状态（尽力解析；子查询/聚合等复杂视图回退 SQL 页直接编辑）----
function parseViewDdl(ddl) {
  const code = String(ddl || '').trim();
  const nameM = code.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([^\s(]+)/i);
  if (!nameM) return null;
  let name = nameM[1].replace(/[`\[\]"]/g, '');
  const dot = name.lastIndexOf('.');
  if (dot >= 0) name = name.slice(dot + 1);
  // 视图名之后的第一个 AS 才是 CREATE VIEW ... AS（SELECT 列别名里的 AS 在其后）
  const afterName = code.slice((nameM.index || 0) + nameM[0].length);
  const asM = afterName.match(/\bAS\b([\s\S]*)$/i);
  if (!asM) return null;
  const body = asM[1].replace(/;+\s*$/, '').trim();
  const distinct = /^\s*SELECT\s+DISTINCT\b/i.test(body);
  // 顶层 FROM（括号深度 0，词边界——换行后的 FROM 也要命中）
  let depth = 0;
  let fromIdx = -1;
  for (let i = 1; i < body.length - 4; i += 1) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && !/[\w]/.test(body[i - 1]) && body.slice(i, i + 4).toUpperCase() === 'FROM' && /\s/.test(body[i + 4] || '')) { fromIdx = i; break; }
  }
  if (fromIdx < 0) return null;
  const selIdx = body.search(/\bSELECT\b/i);
  const selList = body.slice(selIdx + 6, fromIdx).trim().replace(/^DISTINCT\s+/i, '');
  const tail = body.slice(fromIdx + 4).replace(/^\s+/, '');
  const stripRef = (r) => {
    let s = String(r || '').trim().replace(/[`,;]/g, '').replace(/^\[/, '').replace(/\]$/, '');
    const d2 = s.lastIndexOf('.');
    if (d2 >= 0) s = s.slice(d2 + 1);
    return s.replace(/^"|"$/g, '');
  };
  // FROM 首表 + 各 JOIN 段
  const tables = [];
  const joins = [];
  const headM = tail.match(/^([^\s(,]+)(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?\s*(?:(?:LEFT|RIGHT|INNER|FULL|CROSS)?\s*JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|$)/i);
  if (!headM) return null;
  tables.push({ name: stripRef(headM[1]), alias: headM[2] || stripRef(headM[1]) });
  const jRe = /(LEFT|RIGHT|INNER|FULL|CROSS)?\s*JOIN\s+([^\s(,]+)(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?\s*(?:ON\s+([\s\S]+?))?(?=\s*(?:(?:LEFT|RIGHT|INNER|FULL|CROSS)?\s*JOIN\b)|\s*\bWHERE\b|\s*\bGROUP\s+BY\b|\s*\bORDER\s+BY\b|$)/gi;
  for (const m of tail.matchAll(jRe)) {
    const nm = stripRef(m[2]);
    const al = m[3] || nm;
    if (!tables.some((t) => t.name === nm)) tables.push({ name: nm, alias: al });
    if (m[4]) joins.push({ right: nm, type: /LEFT|FULL|RIGHT/i.test(m[1] || '') ? 'LEFT' : 'INNER', on: m[4].trim() });
  }
  if (!tables.length) return null;
  // 顶层逗号切分 SELECT 列
  const colParts = [];
  let d3 = 0;
  let cur = '';
  let inQ = '';
  for (const ch of selList) {
    if (inQ) { cur += ch; if (ch === inQ) inQ = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inQ = ch; cur += ch; continue; }
    if (ch === '(') d3 += 1;
    else if (ch === ')') d3 -= 1;
    if (ch === ',' && d3 === 0) { colParts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) colParts.push(cur);
  const cols = [];
  for (const p of colParts) {
    const s = p.trim();
    if (!s || s === '*') continue;
    const asM2 = s.match(/\bAS\s+([\["`]?[A-Za-z_][\w]*[\]"`]?)\s*$/i) || s.match(/^([\["`]?[A-Za-z_][\w]*[\]"`]?)$/);
    const out = asM2 ? (asM2[1] || '').replace(/[\]"`]/g, '') : null;
    const srcM = s.match(/([A-Za-z_][\w]*)\.([\["`]?[A-Za-z_][\w]*[\]"`]?)/);
    if (srcM) cols.push({ tableAlias: srcM[1], col: srcM[2].replace(/[\]"`]/g, ''), out });
    else cols.push({ tableAlias: null, col: (out || s).replace(/[\]"`]/g, ''), out });
  }
  const whereM = tail.match(/\bWHERE\s+([\s\S]+?)(?=\s+\bGROUP\s+BY\b|\s+\bORDER\s+BY\b|$)/i);
  const orderM = tail.match(/\bORDER\s+BY\s+([\s\S]+)$/i);
  return { name, distinct, tables, joins, cols, where: whereM ? whereM[1].trim() : '', order: orderM ? orderM[1].trim() : '' };
}

// 视图设计器：表/列勾选 + 外键推断 JOIN + WHERE/ORDER + SQL 预览 + 结果预览
export default function ViewDesignTab({ connId, connName, db, schema, name, isNew, session, onStatus, onClose, refreshKey, onDirtyChange }) {
  const d = session ? session.type : 'mysql';
  const [vname, setVname] = useState(isNew ? '' : name || '');
  const [tbls, setTbls] = useState([]); // [{name, alias, cols:[{name, checked, out}]}]
  const [joins, setJoins] = useState([]); // [{id, right, type:'INNER'|'LEFT', on}]
  const [whereText, setWhereText] = useState('');
  const [orderText, setOrderText] = useState('');
  const [distinct, setDistinct] = useState(false);
  const [inner, setInner] = useState(isNew ? 'design' : 'sql');
  const [allTables, setAllTables] = useState([]);
  const [preview, setPreview] = useState(null);
  const [running, setRunning] = useState(false);
  const [origSql, setOrigSql] = useState(''); // 解析失败的原始定义（SQL 页展示）
  const [parseFail, setParseFail] = useState(false);
  // 手动加连接的临时选择
  const [jf, setJf] = useState({ a: null, ca: null, b: null, cb: null });
  const fkCache = useRef({});
  const snap = useRef('');
  const seq = useRef(0);

  const st = useMemo(() => ({ tbls, joins, whereText, orderText, distinct }), [tbls, joins, whereText, orderText, distinct]);
  const selSql = useMemo(() => genSelect(d, db, schema, st), [d, db, schema, st]);

  const snapOf = (s) => JSON.stringify([vname, s.tbls, s.joins, s.whereText, s.orderText, s.distinct]);
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(snapOf(st) !== snap.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vname, tbls, joins, whereText, orderText, distinct]);

  const addTable = async (tName, parsedAlias) => {
    let cols = [];
    try {
      cols = (await dbApi(connId, 'columns', { db, schema, table: tName })).map((c) => ({ name: c.name, checked: false, out: null }));
    } catch (e) {
      message.error(`读取「${tName}」列失败：${e.message}`);
    }
    seq.current += 1;
    const alias = parsedAlias || `t${seq.current}`;
    const others = tbls;
    setTbls((prev) => (prev.some((x) => x.name === tName) ? prev : [...prev, { name: tName, alias, cols }]));
    // 外键推断：新表指向已有表 + 已有表指向新表（推断失败不阻塞设计）
    try {
      if (!fkCache.current[tName]) fkCache.current[tName] = await dbApi(connId, 'fkeys', { db, schema, table: tName });
      const newJoins = [];
      for (const fk of fkCache.current[tName]) {
        const rt = others.find((x) => x.name === fk.refTable);
        if (rt) {
          newJoins.push({
            id: 'j' + joinSeq++,
            right: tName,
            type: 'INNER',
            on: fk.columns.map((c, i) => `${alias}.${qi(d, c)} = ${rt.alias}.${qi(d, fk.refColumns[i])}`).join(' AND '),
          });
        }
      }
      for (const ot of others) {
        if (!fkCache.current[ot.name]) fkCache.current[ot.name] = await dbApi(connId, 'fkeys', { db, schema, table: ot.name });
        for (const fk of fkCache.current[ot.name]) {
          if (fk.refTable === tName) {
            newJoins.push({
              id: 'j' + joinSeq++,
              right: tName,
              type: 'INNER',
              on: fk.columns.map((c, i) => `${ot.alias}.${qi(d, c)} = ${alias}.${qi(d, fk.refColumns[i])}`).join(' AND '),
            });
          }
        }
      }
      if (newJoins.length) setJoins((prev) => [...prev, ...newJoins]);
    } catch { /* 外键内省失败不阻塞设计 */ }
  };

  const rmTable = (tName) => {
    setTbls((prev) => prev.filter((x) => x.name !== tName));
    setJoins((prev) => prev.filter((j) => j.right !== tName && !j.on.includes(tName)));
  };

  // 初始化：新建 → 拉表清单；编辑 → 拉视图 DDL 解析回设计
  useEffect(() => {
    let dead = false;
    (async () => {
      if (isNew) {
        try {
          const ts = await dbApi(connId, 'tables', { db, schema });
          if (!dead) setAllTables(ts);
        } catch (e) { message.error(e.message); }
        snap.current = JSON.stringify(['', [], [], '', '', false]);
        return;
      }
      try {
        const ddl = await dbApi(connId, 'objectDdl', { db, schema, kind: 'view', name });
        const p = parseViewDdl(ddl);
        if (!p) {
          if (dead) return;
          setOrigSql(ddl);
          setParseFail(true);
          snap.current = JSON.stringify([name, [], [], '', '', false]);
          return;
        }
        const ts = await dbApi(connId, 'tables', { db, schema });
        if (dead) return;
        setAllTables(ts);
        setWhereText(p.where);
        setOrderText(p.order);
        setDistinct(!!p.distinct);
        setJoins(p.joins.map((j) => ({ ...j, id: 'j' + joinSeq++ })));
        const loaded = [];
        for (const t of p.tables) {
          if (!ts.includes(t.name)) continue;
          let cols = [];
          try { cols = (await dbApi(connId, 'columns', { db, schema, table: t.name })).map((c) => ({ name: c.name, checked: false, out: null })); } catch { /* 忽略 */ }
          for (const pc of p.cols) {
            const hit = cols.find((c) => c.name === pc.col && (!pc.tableAlias || pc.tableAlias === t.name || pc.tableAlias === t.alias));
            if (hit) { hit.checked = true; if (pc.out && pc.out !== pc.col) hit.out = pc.out; }
          }
          loaded.push({ name: t.name, alias: t.alias, cols });
        }
        setTbls(loaded);
        snap.current = JSON.stringify([p.name, loaded, p.joins, p.where, p.order, !!p.distinct]);
      } catch (e) {
        message.error(`读取视图定义失败：${e.message}`);
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, schema, name, isNew]);

  const runPreview = async () => {
    if (!tbls.length) { message.warning('请先添加表'); return; }
    setRunning(true);
    try {
      const res = await dbApi(connId, 'query', { sqlText: selSql, db, schema });
      const first = (res || []).find((r) => r.error) || (res || [])[0];
      if (first && first.error) {
        message.error(`预览失败：${first.error}`);
        onStatus(`视图预览失败：${first.error}`);
        return;
      }
      setPreview(first && first.columns ? first : null);
      setInner('data');
      onStatus('视图预览完成');
    } catch (e) {
      message.error(e.message);
    } finally {
      setRunning(false);
    }
  };

  // 保存：建视图 DDL 由引擎按方言生成（标识符转义在主进程完成）
  const save = async () => {
    if (!vname.trim()) { message.warning('请填写视图名'); return; }
    if (!tbls.length) { message.warning('请先添加表'); return; }
    setRunning(true);
    try {
      const res = await dbApi(connId, 'createView', { db, schema, name: vname.trim(), select: selSql });
      const errs = (res || []).filter((r) => r.error);
      if (errs.length) {
        message.error(`保存失败：${errs[0].error}`);
        onStatus(`视图保存失败：${errs[0].error}`);
        return;
      }
      message.success(`视图「${vname.trim()}」已保存`);
      onStatus(`${isNew ? '新建' : '修改'}视图 ${vname.trim()} 完成`);
      window.dispatchEvent(new CustomEvent('dh-refresh-tree', { detail: { refreshKey } }));
      // 先清脏标记、等 App 重渲染一拍再关标签（closeTab 从 ref 读最新 dirty）
      if (onDirtyChange) onDirtyChange(false);
      await new Promise((r) => setTimeout(r, 200));
      if (onClose) onClose();
    } catch (e) {
      message.error(e.message);
    } finally {
      setRunning(false);
    }
  };

  const jfCols = (tName) => {
    const t = tbls.find((x) => x.name === tName);
    return t ? t.cols.map((c) => ({ value: c.name, label: c.name })) : [];
  };
  const addManualJoin = () => {
    if (!jf.a || !jf.b || !jf.ca || !jf.cb) { message.warning('请完整选择连接的表和列'); return; }
    const a = tbls.find((x) => x.name === jf.a);
    const b = tbls.find((x) => x.name === jf.b);
    setJoins((prev) => [...prev, { id: 'j' + joinSeq++, right: jf.b, type: 'INNER', on: `${a.alias}.${qi(d, jf.ca)} = ${b.alias}.${qi(d, jf.cb)}` }]);
    setJf({ a: null, ca: null, b: null, cb: null });
  };

  const cardCols = (t) => {
    const on = t.cols.filter((c) => c.checked).length;
    return (
      <div className="dh-vd-card" data-dh-vd-card={t.name} key={t.name}>
        <div className="dh-vd-card-hd">
          <b title={t.name}>{t.name}</b>
          <span className="alias" title={t.alias}>{t.alias}</span>
          <Checkbox
            data-dh-vd-all={t.name}
            checked={on > 0 && on === t.cols.length}
            indeterminate={on > 0 && on < t.cols.length}
            onChange={(e) => setTbls((prev) => prev.map((x) => (x.name === t.name ? { ...x, cols: x.cols.map((c) => ({ ...c, checked: e.target.checked })) } : x)))}
          >
            全选
          </Checkbox>
          <Button size="small" type="text" danger icon={<DeleteOutlined />} data-dh-vd-rm={t.name} onClick={() => rmTable(t.name)} />
        </div>
        <div className="dh-vd-card-cols">
          {t.cols.length === 0 ? <span className="hint">（无列信息）</span> : t.cols.map((c) => (
            <Checkbox
              key={c.name}
              data-dh-vd-col={`${t.name}.${c.name}`}
              checked={c.checked}
              onChange={(e) => setTbls((prev) => prev.map((x) => (x.name === t.name ? { ...x, cols: x.cols.map((cc) => (cc.name === c.name ? { ...cc, checked: e.target.checked } : cc)) } : x)))}
            >
              {c.name}
            </Checkbox>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <Button size="small" type="primary" icon={<SaveOutlined />} loading={running} onClick={save}>保存</Button>
        <Button size="small" icon={<CaretRightOutlined />} loading={running} onClick={runPreview} data-dh-vd="preview">预览结果</Button>
        <span className="lbl">视图名</span>
        <Input size="small" style={{ width: 160 }} value={vname} onChange={(e) => setVname(e.target.value)} data-dh-vd="name" placeholder="view1" />
        <span className="ctx">
          {connName} · 视图设计器{db ? ` · ${db}` : schema ? ` · ${schema}` : ''}
          {!isNew && name ? ` · ${name}` : ''}
        </span>
      </div>
      <Tabs
        size="small"
        className="design-tabs dh-vd-tabs"
        activeKey={inner}
        onChange={setInner}
        items={[
          {
            key: 'design',
            label: '设计',
            children: (
              <div className="dh-vd-wrap">
                <div className="dh-vd-side">
                  <div className="dh-vd-side-hd">添加表</div>
                  <div className="dh-vd-side-list">
                    {allTables.length === 0 ? <span className="hint">（无表）</span> : allTables.map((t) => {
                      const added = tbls.some((x) => x.name === t);
                      return (
                        <div key={t} className="dh-vd-side-row" data-dh-vd-row={t}>
                          <span className="nm">{t}</span>
                          {added ? <span className="ok">已添加</span> : (
                            <Button size="small" type="text" icon={<PlusOutlined />} data-dh-vd-add={t} onClick={() => addTable(t)} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="dh-vd-main">
                  {tbls.length === 0 ? (
                    <div className="hint" style={{ padding: 20 }}>从左侧添加表，勾选需要的列；多表时按外键自动生成连接。</div>
                  ) : (
                    <div className="dh-vd-cards">{tbls.map(cardCols)}</div>
                  )}
                  {tbls.length > 1 && (
                    <div className="dh-vd-joins">
                      <div className="dh-vd-sec-hd">连接（JOIN）</div>
                      {joins.length === 0 ? <div className="hint">未发现外键关系，可手动添加连接。</div> : joins.map((j) => (
                        <div className="dh-vd-join" key={j.id} data-dh-vd-join={j.right}>
                          <Select
                            size="small"
                            style={{ width: 86 }}
                            value={j.type}
                            data-dh-vd-jtype={j.right}
                            onChange={(v) => setJoins((prev) => prev.map((x) => (x.id === j.id ? { ...x, type: v } : x)))}
                            options={[{ value: 'INNER', label: 'INNER' }, { value: 'LEFT', label: 'LEFT' }]}
                          />
                          <Input
                            size="small"
                            value={j.on}
                            data-dh-vd-jon={j.right}
                            onChange={(e) => setJoins((prev) => prev.map((x) => (x.id === j.id ? { ...x, on: e.target.value } : x)))}
                          />
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} data-dh-vd-jrm={j.right} onClick={() => setJoins((prev) => prev.filter((x) => x.id !== j.id))} />
                        </div>
                      ))}
                      <div className="dh-vd-join-form">
                        <Select size="small" showSearch style={{ width: 130 }} placeholder="表A" value={jf.a} data-dh-vd="ja" onChange={(v) => setJf((p) => ({ ...p, a: v, ca: null }))} options={tbls.map((t) => ({ value: t.name, label: t.name }))} />
                        <Select size="small" showSearch style={{ width: 110 }} placeholder="列A" value={jf.ca} data-dh-vd="jca" onChange={(v) => setJf((p) => ({ ...p, ca: v }))} options={jfCols(jf.a)} />
                        <span className="eq">=</span>
                        <Select size="small" showSearch style={{ width: 130 }} placeholder="表B" value={jf.b} data-dh-vd="jb" onChange={(v) => setJf((p) => ({ ...p, b: v, cb: null }))} options={tbls.map((t) => ({ value: t.name, label: t.name }))} />
                        <Select size="small" showSearch style={{ width: 110 }} placeholder="列B" value={jf.cb} data-dh-vd="jcb" onChange={(v) => setJf((p) => ({ ...p, cb: v }))} options={jfCols(jf.b)} />
                        <Button size="small" icon={<PlusOutlined />} data-dh-vd="addjoin" onClick={addManualJoin}>添加连接</Button>
                      </div>
                    </div>
                  )}
                  <div className="dh-vd-cond">
                    <Checkbox data-dh-vd="distinct" checked={distinct} onChange={(e) => setDistinct(e.target.checked)}>DISTINCT</Checkbox>
                    <span className="lbl">WHERE</span>
                    <Input size="small" value={whereText} data-dh-vd="where" onChange={(e) => setWhereText(e.target.value)} placeholder="如 t1.salary > 100" />
                    <span className="lbl">ORDER BY</span>
                    <Input size="small" value={orderText} data-dh-vd="order" onChange={(e) => setOrderText(e.target.value)} placeholder="如 t1.id DESC" />
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: 'sql',
            label: 'SQL 预览',
            children: (
              <div className="dh-vd-sqlpane">
                {parseFail && origSql ? (
                  <>
                    <div className="hint">该视图定义无法解析为可视化设计（可能包含子查询/聚合等），请直接编辑 SQL 后保存：</div>
                    <pre className="dh-vd-sql" data-dh-vd="origsql">{origSql}</pre>
                  </>
                ) : (
                  <pre className="dh-vd-sql" data-dh-vd="sql">{`-- CREATE VIEW ${vname || '<视图名>'} AS（建视图语句由引擎按方言生成）\n${selSql}`}</pre>
                )}
              </div>
            ),
          },
          {
            key: 'data',
            label: '结果预览',
            children: preview && preview.columns && preview.columns.length ? (
              <ResultGrid columns={preview.columns} rows={preview.rows} />
            ) : (
              <div className="hint" style={{ padding: 20 }}>点击工具栏「预览结果」运行当前设计的 SELECT。</div>
            ),
          },
        ]}
      />
    </div>
  );
}
