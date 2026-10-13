import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Input, Pagination, Popover, Select, Space, Table, message } from 'antd';
import {
  CaretDownOutlined, CloseCircleOutlined, CloseOutlined, CopyOutlined, ExportOutlined, FilterOutlined,
  ImportOutlined, KeyOutlined, MinusOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, SortAscendingOutlined,
  SortDescendingOutlined,
} from '@ant-design/icons';
import { dbApi, copyText } from '../../api';
import { fmt, useGridHeight } from '../../format';
import ExportModal from '../ExportModal';

// ---- 可视化筛选：条件 → WHERE 片段 ----
const NUM_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|number|bit|serial|money)/i;
const FILTER_OPS = [
  { v: '=', l: '等于' },
  { v: '<>', l: '不等于' },
  { v: '>', l: '大于' },
  { v: '<', l: '小于' },
  { v: '>=', l: '大于等于' },
  { v: '<=', l: '小于等于' },
  { v: 'LIKE', l: '包含' },
  { v: 'NOT LIKE', l: '不包含' },
  { v: 'IN', l: '属于 IN' },
  { v: 'NOT IN', l: '不属于 NOT IN' },
  { v: 'IS NULL', l: '为空' },
  { v: 'IS NOT NULL', l: '不为空' },
];
const NO_VALUE_OPS = ['IS NULL', 'IS NOT NULL'];

// 按列类型决定字面量形态：数字列裸值，其余按字符串转义（'' 转义）
function quoteVal(metaList, col, v) {
  const c = metaList.find((m) => m.name === col);
  const t = c && c.dataType ? String(c.dataType) : '';
  const s = String(v).trim();
  if (t && NUM_TYPE.test(t)) return s;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function condSql(metaList, c) {
  if (!c.col) return null;
  if (NO_VALUE_OPS.includes(c.op)) return `${c.col} ${c.op}`;
  const vals = String(c.val == null ? '' : c.val).trim();
  if (c.op === 'IN' || c.op === 'NOT IN') {
    const parts = vals.split(/[,，]/).map((x) => x.trim()).filter(Boolean).map((x) => quoteVal(metaList, c.col, x));
    return parts.length ? `${c.col} ${c.op} (${parts.join(', ')})` : null;
  }
  if (c.op === 'LIKE' || c.op === 'NOT LIKE') {
    if (!vals) return null;
    const v = vals.includes('%') ? vals : `%${vals}%`;
    return `${c.col} ${c.op} '${v.replace(/'/g, "''")}'`;
  }
  if (!vals) return null;
  return `${c.col} ${c.op} ${quoteVal(metaList, c.col, vals)}`;
}

function buildWhere(metaList, conds) {
  return conds.map((c) => condSql(metaList, c)).filter(Boolean).join(' AND ');
}

// ---- 右键“复制为 SQL”：值形态与列类型匹配（数字裸值 / 字符串转义 / NULL） ----
function sqlVal(metaList, col, v) {
  if (v === null || v === undefined) return 'NULL';
  return quoteVal(metaList, col, v);
}

function insertSql(metaList, table, vals) {
  const cols = metaList.map((c) => c.name);
  const vs = vals.map((v, i) => sqlVal(metaList, cols[i], v));
  return `INSERT INTO ${table} (${cols.join(', ')})\nVALUES (${vs.join(', ')});`;
}

function updateSql(metaList, table, origVals, curVals) {
  const pkCols = metaList.filter((c) => c.pk).map((c) => c.name);
  const whereCols = pkCols.length ? pkCols : metaList.map((c) => c.name);
  const indexOf = {};
  metaList.forEach((c, i) => { indexOf[c.name] = i; });
  const setPart = metaList.map((c, i) => `${c.name} = ${sqlVal(metaList, c.name, curVals[i])}`).join(', ');
  const wherePart = whereCols.map((cn) => `${cn} = ${sqlVal(metaList, cn, origVals[indexOf[cn]])}`).join(' AND ');
  return `UPDATE ${table}\nSET ${setPart}\nWHERE ${wherePart};`;
}

// CSV 字段转义：含逗号/引号/换行的值整体包引号，内部引号翻倍
const csvEsc = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

// 数据表格标签页：分页浏览 + 单元格编辑 + 增删行 + WHERE 筛选 + 导出/导入向导
export default function DataTab({ connId, connName, db, schema, table, onStatus, onChanged, active, onOpenImport }) {
  const [meta, setMeta] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [where, setWhere] = useState('');
  const [order, setOrder] = useState(null); // {col, dir}
  const [filterState, setFilterState] = useState({ conds: [], sortCol: '', sortDir: 'ASC' }); // 最近一次应用的可视化配置
  const [filterOpen, setFilterOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState({}); // 原始行下标 -> {列名: {v, isNull}}
  const [adds, setAdds] = useState([]); // 新增行（数组，按 meta 对齐）
  const [dels, setDels] = useState([]); // 原始行下标
  const [sel, setSel] = useState([]);
  const [cell, setCell] = useState(null); // {idx, col}
  const [cellDraft, setCellDraft] = useState('');
  const [readonly, setReadonly] = useState(false);
  const [exportState, setExportState] = useState(null);
  const [gridRef, gridH] = useGridHeight(60);
  const loadToken = useRef(0);
  const autoSaveRef = useRef(false); // 点其他行时自动保存（仅现有行的修改）
  const savingRef = useRef(false);

  const load = useCallback(async (keepEdit) => {
    const token = ++loadToken.current;
    setLoading(true);
    try {
      const r = await dbApi(connId, 'page', {
        db, schema, table, pageNo, pageSize,
        where, orderCol: order && order.col, orderDir: order && order.dir,
      });
      if (token !== loadToken.current) return;
      setMeta(r.columns);
      setRows(r.rows);
      setTotal(r.total);
      setReadonly(!!r.readonly);
      setEdits({});
      setAdds([]);
      setDels([]);
      setSel([]);
      if (!keepEdit) setCell(null);
      onStatus(`${table}：${r.total} 行 · 第 ${pageNo}/${Math.max(1, Math.ceil(r.total / pageSize))} 页`);
    } catch (e) {
      message.error(e.message);
      onStatus(`${table}：加载失败`);
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, schema, table, pageNo, pageSize, where, order]);

  useEffect(() => {
    load();
  }, [load]);

  // F5 刷新（仅当前激活标签，避免所有隐藏的数据表一起刷新）
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.key === 'F5') {
        e.preventDefault();
        load();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, load]);

  const dirty = Object.keys(edits).length + adds.length + dels.length;

  // ---- 编辑 ----
  const startEdit = (idx, colName, v) => {
    if (dels.includes(idx)) return;
    // 切换单元格时，把已暂存的单元格修改（不含新增/删除行）自动落库
    if (Object.keys(edits).length && !adds.length && !dels.length) autoSaveRef.current = true;
    setCell({ idx, col: colName });
    setCellDraft(v === null || v === undefined ? '' : String(v));
  };

  // 提交当前单元格：回车或点击别处；值有变且无新增/删除行混排时自动落库
  const commit = () => {
    if (!cell) return;
    const { idx, col } = cell;
    const ci = meta.findIndex((c) => c.name === col);
    const isAdd = idx >= rows.length;
    const orig = isAdd ? adds[idx - rows.length][ci] : rows[idx][ci];
    const changed = !isAdd && cellDraft !== (orig == null ? '' : String(orig));
    if (isAdd) {
      setAdds((prev) => prev.map((r, ri) => (ri === idx - rows.length ? r.map((cv, cvi) => (cvi === ci ? cellDraft : cv)) : r)));
    } else if (changed) {
      setEdits((prev) => ({ ...prev, [idx]: { ...(prev[idx] || {}), [col]: { v: cellDraft, isNull: false } } }));
      if (!adds.length && !dels.length) autoSaveRef.current = true;
    } else {
      // 值与原值相同：不算修改；若该列此前有未保存修改（改回了原值）则一并清除
      setEdits((prev) => {
        if (!prev[idx] || !prev[idx][col]) return prev;
        const n = { ...prev };
        const row = { ...n[idx] };
        delete row[col];
        if (Object.keys(row).length) n[idx] = row;
        else delete n[idx];
        return n;
      });
    }
    setCell(null);
  };

  // 提交或切换单元格后触发自动保存（保留当前编辑态，不打断连续录入）
  useEffect(() => {
    if (!autoSaveRef.current) return;
    autoSaveRef.current = false;
    if (Object.keys(edits).length && !adds.length && !dels.length) save(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, adds, dels, cell]);

  const setNull = (idx, colName) => {
    const isAdd = idx >= rows.length;
    if (isAdd) {
      const i = idx - rows.length;
      const ci = meta.findIndex((c) => c.name === colName);
      setAdds((prev) => prev.map((r, ri) => (ri === i ? r.map((cv, cvi) => (cvi === ci ? null : cv)) : r)));
    } else {
      setEdits((prev) => ({ ...prev, [idx]: { ...(prev[idx] || {}), [colName]: { v: '', isNull: true } } }));
    }
    setCell(null);
  };

  const clearCellMod = (idx, colName) => {
    if (idx >= rows.length) return;
    setEdits((prev) => {
      const n = { ...prev };
      if (n[idx]) {
        delete n[idx][colName];
        if (!Object.keys(n[idx]).length) delete n[idx];
      }
      return n;
    });
  };

  const addRow = () => setAdds((prev) => [...prev, meta.map(() => null)]);

  const delRows = () => {
    const orig = sel.filter((i) => i < rows.length);
    const addIdx = sel.filter((i) => i >= rows.length).map((i) => i - rows.length);
    if (addIdx.length) setAdds((prev) => prev.filter((_, i) => !addIdx.includes(i)));
    if (orig.length) setDels((prev) => Array.from(new Set([...prev, ...orig])));
    setSel([]);
  };

  // 右键“删除此行”：现有行标记删除，新增行直接移除
  const deleteRow = (idx) => {
    if (idx >= rows.length) {
      setAdds((prev) => prev.filter((_, i) => i !== idx - rows.length));
    } else {
      setDels((prev) => Array.from(new Set([...prev, idx])));
    }
    setSel((prev) => prev.filter((k) => k !== idx));
    setCell(null);
  };

  // 行的当前值（叠加未保存的单元格修改）与原始值，供“复制为 SQL”使用
  const curValsOf = (idx) => {
    if (idx >= rows.length) return adds[idx - rows.length].slice();
    return meta.map((c, i) => {
      const e = edits[idx] ? edits[idx][c.name] : undefined;
      return e === undefined ? rows[idx][i] : e.isNull ? null : e.v;
    });
  };
  const origValsOf = (idx) => (idx < rows.length ? rows[idx].slice() : adds[idx - rows.length].slice());

  // ---- 多行复制：选中行 → CSV / INSERT（值叠加未保存修改，新增行一并计入） ----
  const copySel = (withHeader, asInsert) => {
    if (!sel.length) return;
    const idxs = [...sel].sort((a, b) => a - b);
    const text = asInsert
      ? idxs.map((i) => insertSql(meta, table, curValsOf(i))).join('\n')
      : (withHeader ? meta.map((c) => csvEsc(c.name)).join(',') + '\n' : '') +
        idxs.map((i) => meta.map((_c, ci) => csvEsc(fmt(curValsOf(i)[ci]))).join(',')).join('\n');
    copyText(text).then(() => message.success(`已复制 ${idxs.length} 行${asInsert ? ' INSERT 语句' : withHeader ? '（含列名）' : '（CSV）'}`));
  };

  const save = async (keepEditor) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const spec = { db, schema, table, columns: meta, updates: [], inserts: [], deletes: [] };
    for (const arr of adds) {
      const o = {};
      meta.forEach((c, i) => {
        o[c.name] = arr[i];
      });
      spec.inserts.push(o);
    }
    for (const [idxStr, cols] of Object.entries(edits)) {
      const idx = Number(idxStr);
      if (dels.includes(idx)) continue;
      const row = {};
      meta.forEach((c, i) => {
        row[c.name] = rows[idx][i];
      });
      const set = {};
      for (const [c, e] of Object.entries(cols)) set[c] = e.isNull ? null : e.v;
      if (Object.keys(set).length) spec.updates.push({ row, set });
    }
    for (const idx of dels) {
      const row = {};
      meta.forEach((c, i) => {
        row[c.name] = rows[idx][i];
      });
      spec.deletes.push({ row });
    }
    try {
      const r = await dbApi(connId, 'changes', spec);
      message.success(keepEditor ? '已自动保存' : `已保存：执行 ${r.executed} 条语句`);
      load(keepEditor);
    } catch (e) {
      message.error(`保存失败：${e.message}`);
    } finally {
      savingRef.current = false;
    }
  };

  // 导出：抓取全部行（沿用当前筛选与排序，自动翻页，每批 1000 行）
  const fetchAllRows = async () => {
    const PS = 1000;
    const all = [];
    let p = 1;
    let cols = meta.map((c) => c.name);
    for (;;) {
      const r = await dbApi(connId, 'page', {
        db, schema, table, pageNo: p, pageSize: PS,
        where, orderCol: order && order.col, orderDir: order && order.dir,
      });
      cols = r.columns.map((c) => c.name);
      all.push(...r.rows);
      if (!r.rows.length || all.length >= r.total) break;
      p += 1;
    }
    return { columns: cols, rows: all };
  };

  const openExport = () =>
    setExportState({
      title: `导出「${table}」数据`,
      name: table,
      table,
      columns: meta.map((c) => c.name),
      rows,
      totalHint: total,
      fetchRows: fetchAllRows,
      hint: (where || order ? '“全部行”按当前筛选与排序导出；' : '') + '导出的是已保存的数据（不含未保存的编辑）。',
    });

  // ---- 视图数据 ----
  const view = useMemo(
    () => [
      ...rows.map((r, i) => ({ __idx: i, cells: r })),
      ...adds.map((r, i) => ({ __idx: rows.length + i, cells: r })),
    ],
    [rows, adds]
  );

  const getEdit = (idx, colName) => (edits[idx] ? edits[idx][colName] : undefined);

  const renderCell = (c, rec) => {
    const idx = rec.__idx;
    const isAdd = idx >= rows.length;
    if (cell && cell.idx === idx && cell.col === c.name) {
      return (
        <Input
          size="small"
          className="cell-edit-input"
          autoFocus
          value={cellDraft}
          onChange={(e) => setCellDraft(e.target.value)}
          onBlur={() => commit()}
          onPressEnter={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setCell(null);
          }}
        />
      );
    }
    let v;
    if (isAdd) v = rec.cells[meta.indexOf(c)];
    else {
      const e = getEdit(idx, c.name);
      if (e !== undefined) v = e.isNull ? null : e.v;
      else v = rec.cells[meta.indexOf(c)];
    }
    const edited = isAdd || getEdit(idx, c.name) !== undefined;
    const copyVal = () => copyText(fmt(v)).then(() => message.success('已复制单元格值'));
    const copyRowCsv = (withHeader) => {
      const rec2 = view.find((r) => r.__idx === idx);
      if (!rec2) return;
      const line = meta.map((_cc, i) => csvEsc(fmt(rec2.cells[i]))).join(',');
      const text = withHeader ? meta.map((cc) => csvEsc(cc.name)).join(',') + '\n' + line : line;
      copyText(text).then(() => message.success(withHeader ? '已复制本行（含列名）' : '已复制本行（CSV）'));
    };
    const copySqlOk = (sql) => copyText(sql).then(() => message.success('已复制 SQL 语句'));
    const cellDiv = (
      <div
        className={'cell' + (v == null ? ' null' : '') + (edited ? ' dirty' : '')}
        onClick={() => startEdit(idx, c.name, v)}
        title={fmt(v)}
      >
        {fmt(v)}
      </div>
    );
    if (readonly) {
      return (
        <Dropdown
          trigger={['contextMenu']}
          menu={{
            items: [
              { key: 'copy', label: '复制单元格值', icon: <CopyOutlined /> },
              { key: 'copyrow', label: '复制本行（CSV）', icon: <CopyOutlined /> },
              { key: 'copyrowh', label: '复制本行（含列名）', icon: <CopyOutlined /> },
              { type: 'divider' },
              { key: 'ins', label: '复制为 INSERT 语句', icon: <CopyOutlined /> },
              { type: 'divider' },
              { key: 'reload', label: '刷新', icon: <ReloadOutlined /> },
            ],
            onClick: ({ key }) => {
              if (key === 'copy') copyVal();
              else if (key === 'copyrow') copyRowCsv(false);
              else if (key === 'copyrowh') copyRowCsv(true);
              else if (key === 'ins') copySqlOk(insertSql(meta, table, rec.cells));
              else if (key === 'reload') load();
            },
          }}
        >
          {cellDiv}
        </Dropdown>
      );
    }
    return (
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items: [
            { key: 'copy', label: '复制单元格值', icon: <CopyOutlined /> },
            { key: 'copyrow', label: '复制本行（CSV）', icon: <CopyOutlined /> },
            { key: 'copyrowh', label: '复制本行（含列名）', icon: <CopyOutlined /> },
            { type: 'divider' },
            { key: 'ins', label: '复制为 INSERT 语句', icon: <CopyOutlined /> },
            !isAdd ? { key: 'upd', label: '复制为 UPDATE 语句', icon: <CopyOutlined /> } : null,
            { type: 'divider' },
            { key: 'null', label: '设为 NULL' },
            !isAdd ? { key: 'reset', label: '清除单元格修改' } : null,
            { type: 'divider' },
            { key: 'add', label: '新增记录', icon: <PlusOutlined /> },
            { key: 'del', label: isAdd ? '移除新增行' : '删除此行', icon: <MinusOutlined />, danger: true },
            { type: 'divider' },
            { key: 'reload', label: '刷新', icon: <ReloadOutlined /> },
          ].filter(Boolean),
          onClick: ({ key }) => {
            if (key === 'copy') copyVal();
            else if (key === 'copyrow') copyRowCsv(false);
            else if (key === 'copyrowh') copyRowCsv(true);
            else if (key === 'ins') copySqlOk(insertSql(meta, table, curValsOf(idx)));
            else if (key === 'upd') copySqlOk(updateSql(meta, table, origValsOf(idx), curValsOf(idx)));
            else if (key === 'null') setNull(idx, c.name);
            else if (key === 'reset') clearCellMod(idx, c.name);
            else if (key === 'add') addRow();
            else if (key === 'del') deleteRow(idx);
            else if (key === 'reload') load();
          },
        }}
      >
        <div
          className={'cell' + (v == null ? ' null' : '') + (edited ? ' dirty' : '')}
          onClick={() => startEdit(idx, c.name, v)}
          title={fmt(v)}
        >
          {fmt(v)}
        </div>
      </Dropdown>
    );
  };

  const columns = useMemo(
    () =>
      meta.map((c, i) => ({
        key: c.name,
        title: (
          <Dropdown
            trigger={['contextMenu']}
            menu={{
              items: [
                { key: 'copy', label: '复制列名', icon: <CopyOutlined /> },
                { type: 'divider' },
                { key: 'asc', label: '升序排序', icon: <SortAscendingOutlined /> },
                { key: 'desc', label: '降序排序', icon: <SortDescendingOutlined /> },
                { key: 'none', label: '取消排序', disabled: !order },
              ],
              onClick: ({ key }) => {
                if (key === 'copy') {
                  copyText(c.name).then(() => message.success('已复制列名'));
                  return;
                }
                setPageNo(1);
                setOrder(key === 'asc' ? { col: c.name, dir: 'ASC' } : key === 'desc' ? { col: c.name, dir: 'DESC' } : null);
              },
            }}
          >
            <span>
              {c.pk ? <KeyOutlined style={{ color: '#faad14', marginRight: 4 }} /> : null}
              {c.name}
              <span className="col-type">{c.display}</span>
            </span>
          </Dropdown>
        ),
        // 末列不设宽度：自动吃掉容器剩余空间，避免复选框列被撑宽
        width: i === meta.length - 1 ? undefined : Math.min(320, Math.max(120, (c.display ? c.display.length : 4) * 9 + c.name.length * 9 + 60)),
        ellipsis: true,
        sorter: true,
        sortOrder: order && order.col === c.name ? (order.dir === 'DESC' ? 'descend' : 'ascend') : null,
        render: (_, rec) => renderCell(c, rec),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, order, edits, adds, dels, cell, cellDraft, rows]
  );

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading} title="重新加载（F5）">
          刷新
        </Button>
        <Popover
          trigger="click"
          placement="bottomLeft"
          arrow={false}
          destroyTooltipOnHide
          open={filterOpen}
          onOpenChange={setFilterOpen}
          content={
            <FilterPanel
              meta={meta}
              init={filterState}
              rawInit={where}
              onClose={() => setFilterOpen(false)}
              onApply={(r) => {
                setFilterState(r);
                setPageNo(1);
                setWhere(r.where);
                setOrder(r.sortCol ? { col: r.sortCol, dir: r.sortDir } : null);
                setFilterOpen(false);
              }}
            />
          }
        >
          <Button size="small" icon={<FilterOutlined />} type={where || order ? 'primary' : 'default'}>
            筛选/排序{where || order ? ' ●' : ''}
          </Button>
        </Popover>
        {(where || order) && (
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            title="清除筛选与排序"
            onClick={() => {
              setWhere('');
              setOrder(null);
              setFilterState({ conds: [], sortCol: '', sortDir: 'ASC' });
              setPageNo(1);
            }}
          />
        )}
        <Select
          size="small"
          value={pageSize}
          style={{ width: 110 }}
          onChange={(v) => {
            setPageSize(v);
            setPageNo(1);
          }}
          options={[50, 100, 500, 1000, 5000].map((v) => ({ value: v, label: `${v} 行/页` }))}
        />
        <span className="toolbar-spacer" />
        <Dropdown
          trigger={['click']}
          placement="bottomLeft"
          menu={{
            items: [
              { key: 'csv', label: 'CSV（仅数据行）', icon: <CopyOutlined /> },
              { key: 'csvh', label: 'CSV（含列名行）', icon: <CopyOutlined /> },
              { type: 'divider' },
              { key: 'ins', label: 'INSERT 语句（每行一条）', icon: <CopyOutlined /> },
            ],
            onClick: ({ key }) => {
              if (key === 'csv') copySel(false, false);
              else if (key === 'csvh') copySel(true, false);
              else if (key === 'ins') copySel(false, true);
            },
          }}
        >
          <Button size="small" icon={<CopyOutlined />} disabled={!sel.length} title="复制选中行：CSV / INSERT（只读数据页同样可用）">
            复制选中行{sel.length ? `(${sel.length})` : ''}
          </Button>
        </Dropdown>
        {!readonly && (
          <>
            <Button size="small" icon={<PlusOutlined />} onClick={addRow}>
              新增行
            </Button>
            <Button size="small" icon={<MinusOutlined />} disabled={!sel.length} onClick={delRows}>
              删除行{sel.length ? `(${sel.length})` : ''}
            </Button>
            <Button size="small" type={dirty ? 'primary' : 'default'} icon={<SaveOutlined />} disabled={!dirty} onClick={() => save()}>
              保存更改{dirty ? `(${dirty})` : ''}
            </Button>
            <Button
              size="small"
              icon={<CloseCircleOutlined />}
              disabled={!dirty}
              onClick={() => {
                setEdits({});
                setAdds([]);
                setDels([]);
                setSel([]);
                setCell(null);
                message.info('已放弃全部未保存更改');
              }}
            >
              放弃更改
            </Button>
          </>
        )}
        {onOpenImport ? (
          <Button
            size="small"
            icon={<ImportOutlined />}
            title="导入向导：CSV / JSON → 当前表（字段映射、预览、分批写入）"
            onClick={() => onOpenImport({ mode: 'table', table })}
          >
            导入向导…
          </Button>
        ) : null}
        <Button size="small" icon={<ExportOutlined />} onClick={openExport} title="导出 CSV / JSON / SQL / Markdown / HTML（可选全部行）">
          导出…
        </Button>
        <span className="ctx">
          {connName} · {table}
          {order ? ` · 排序 ${order.col} ${order.dir}` : ''}
          {where ? ` · 筛选 ${where}` : ''}
          {dirty ? ' · 有未保存更改' : ''}
        </span>
      </div>
      <div className="grid-area dh-grid" ref={gridRef}>
        <Table
          size="small"
          virtual
          loading={loading}
          columns={columns}
          dataSource={view}
          rowKey="__idx"
          pagination={false}
          scroll={{ x: 'max-content', y: gridH }}
          rowClassName={(rec) => {
            const idx = rec.__idx;
            if (dels.includes(idx)) return 'row-deleted';
            if (idx >= rows.length) return 'row-added';
            if (edits[idx]) return 'row-edited';
            return '';
          }}
          rowSelection={{
            // 只读页（视图等）也开放勾选：配合“复制选中行”多行复制
            columnWidth: 36,
            selectedRowKeys: sel,
            onChange: (keys) => setSel(keys),
            getCheckboxProps: (rec) => ({ disabled: dels.includes(rec.__idx) }),
          }}
          onChange={(_p, _f, sorter) => {
            if (sorter && sorter.field) {
              setPageNo(1);
              setOrder({ col: sorter.field, dir: sorter.order === 'descend' ? 'DESC' : 'ASC' });
            }
          }}
        />
      </div>
      <div className="grid-pager">
        <span>
          共 {total} 行{dirty ? ` · ${dirty} 处未保存` : ''}
        </span>
        <Pagination
          size="small"
          current={pageNo}
          pageSize={pageSize}
          total={total}
          showSizeChanger={false}
          onChange={setPageNo}
        />
      </div>
      <ExportModal state={exportState} onClose={() => setExportState(null)} />
    </div>
  );
}

// 可视化筛选/排序面板（DataTab 工具栏 Popover 内容；关闭即卸载，重开取最近一次应用的状态）
function FilterPanel({ meta, init, rawInit, onClose, onApply }) {
  const [rawMode, setRawMode] = useState(false);
  const [rawSql, setRawSql] = useState('');
  const [conds, setConds] = useState(init.conds && init.conds.length ? init.conds : [{ col: '', op: '=', val: '' }]);
  const [sortCol, setSortCol] = useState(init.sortCol || '');
  const [sortDir, setSortDir] = useState(init.sortDir || 'ASC');

  useEffect(() => {
    // 打开面板时带出当前 WHERE（含 SQL 模式手写的），切到 SQL 模式即可继续编辑
    if (rawInit && !(init.conds && init.conds.length)) setRawSql(rawInit);
    else if (init.conds && init.conds.length) setRawSql(rawInit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const colOptions = (meta || []).map((c) => ({ value: c.name, label: `${c.name}（${c.display || c.dataType || ''}）` }));
  const upd = (i, patch) => setConds((prev) => prev.map((c, ci) => (ci === i ? { ...c, ...patch } : c)));
  const built = rawMode ? rawSql.trim() : buildWhere(meta || [], conds);

  const apply = () =>
    onApply(
      rawMode
        ? { where: rawSql.trim(), conds: [], sortCol, sortDir }
        : { where: built, conds, sortCol, sortDir }
    );

  return (
    <div className="filter-panel">
      <div className="filter-head">
        <span>筛选条件（多条件 AND）</span>
        <a onClick={() => setRawMode((m) => !m)}>{rawMode ? '切换可视化模式' : '切换 SQL 模式'}</a>
      </div>
      {rawMode ? (
        <Input.TextArea
          size="small"
          rows={3}
          placeholder="WHERE 子句，如 id > 10 AND name LIKE '%abc%'"
          value={rawSql}
          onChange={(e) => setRawSql(e.target.value)}
        />
      ) : (
        <div>
          {conds.map((c, i) => (
            <div key={i} className="filter-cond">
              <Select
                size="small"
                showSearch
                style={{ width: 150 }}
                placeholder="列"
                value={c.col || undefined}
                options={colOptions}
                onChange={(v) => upd(i, { col: v })}
              />
              <Select
                size="small"
                style={{ width: 108 }}
                value={c.op}
                options={FILTER_OPS.map((o) => ({ value: o.v, label: o.l }))}
                onChange={(v) => upd(i, { op: v })}
              />
              <Input
                size="small"
                style={{ flex: 1, minWidth: 80 }}
                placeholder={NO_VALUE_OPS.includes(c.op) ? '（无需值）' : '值'}
                disabled={NO_VALUE_OPS.includes(c.op)}
                value={c.val}
                onChange={(e) => upd(i, { val: e.target.value })}
                onPressEnter={apply}
              />
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined />}
                disabled={conds.length === 1}
                onClick={() => setConds((prev) => prev.filter((_, ci) => ci !== i))}
              />
            </div>
          ))}
          <a onClick={() => setConds((prev) => [...prev, { col: '', op: '=', val: '' }])}>
            <PlusOutlined /> 添加条件
          </a>
        </div>
      )}
      <div className="filter-head" style={{ marginTop: 10 }}>
        <span>
          <SortAscendingOutlined /> 排序
        </span>
      </div>
      <Space size={6}>
        <Select
          size="small"
          allowClear
          showSearch
          style={{ width: 170 }}
          placeholder="排序列（可空）"
          value={sortCol || undefined}
          options={colOptions}
          onChange={(v) => setSortCol(v || '')}
        />
        <Select
          size="small"
          style={{ width: 84 }}
          disabled={!sortCol}
          value={sortDir}
          options={[{ value: 'ASC', label: '升序 ↑' }, { value: 'DESC', label: '降序 ↓' }]}
          onChange={setSortDir}
        />
      </Space>
      <div className="filter-sql">
        {built ? `WHERE ${built}` : '（无筛选）'}
        {sortCol ? `\nORDER BY ${sortCol} ${sortDir}` : ''}
      </div>
      <div className="filter-foot">
        <Button size="small" onClick={() => onApply({ where: '', conds: [], sortCol: '', sortDir: 'ASC' })}>
          清除全部
        </Button>
        <span style={{ flex: 1 }} />
        <Button size="small" onClick={onClose}>
          取消
        </Button>
        <Button size="small" type="primary" onClick={apply}>
          应用
        </Button>
      </div>
    </div>
  );
}
