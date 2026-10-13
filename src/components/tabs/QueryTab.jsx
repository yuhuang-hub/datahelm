import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal, Select, Space, Tabs, message } from 'antd';
import { CaretRightOutlined, ClearOutlined, DiffOutlined, ExportOutlined, FormatPainterOutlined, HistoryOutlined, NodeIndexOutlined, RedoOutlined, SaveOutlined, SettingOutlined, ShrinkOutlined, UndoOutlined } from '@ant-design/icons';
import SqlEditor from '../SqlEditor';
import ResultGrid from '../ResultGrid';
import PlanTree, { parsePlan, countPlanNodes } from '../PlanTree';
import ExportModal from '../ExportModal';
import FloatMenu from '../FloatMenu';
import { dbApi, dbExplain, queriesApi, copyText } from '../../api';
import { formatSql, minifySql } from '../../sqlFormat';

const histKeyOf = (connId) => 'dh_hist_' + connId;
// 慢查询阈值（v0927.52）：≥1s 标橙、≥5s 标红——消息面板与历史弹窗同一套口径
const SLOW_MS = 1000;
const VSLOW_MS = 5000;
const msClsOf = (ms) => (ms >= VSLOW_MS ? 'dh-ms-vslow' : ms >= SLOW_MS ? 'dh-ms-slow' : '');
const loadHist = (connId) => {
  try {
    return JSON.parse(localStorage.getItem(histKeyOf(connId)) || '[]');
  } catch {
    return [];
  }
};
const pushHist = (connId, sql, ms, rows, ok) => {
  try {
    const h = loadHist(connId);
    h.unshift({ sql, t: Date.now(), ms: typeof ms === 'number' ? ms : undefined, rows: rows || 0, ok: ok !== false });
    localStorage.setItem(histKeyOf(connId), JSON.stringify(h.slice(0, 50)));
  } catch {}
};
const clearHist = (connId) => {
  try { localStorage.removeItem(histKeyOf(connId)); } catch {}
};
// 收藏标记回写（v0927.52）：按条目时间戳定位（push 时的 Date.now()，天然唯一）
const setFavOf = (cid, t, fav) => {
  try {
    const h = loadHist(cid).map((x) => (x.t === t ? { ...x, fav: !!fav } : x));
    localStorage.setItem(histKeyOf(cid), JSON.stringify(h));
  } catch {}
};
const connNameOf = (conns, id) => {
  const c = (conns || []).find((x) => x.id === id);
  return c && c.name ? c.name : id;
};
// 跨连接聚合（v0927.52）：扫全部 dh_hist_* 键，条目打上 connId 后按时间归并
const loadHistAll = () => {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.indexOf('dh_hist_') === 0) {
        const cid = k.slice(8);
        JSON.parse(localStorage.getItem(k) || '[]').forEach((h) => out.push({ ...h, connId: cid }));
      }
    }
  } catch {}
  return out.sort((a, b) => (b.t || 0) - (a.t || 0));
};

// SQL 查询标签页：编辑器 + 多结果集 + 消息面板 + 查询历史 + 保存查询
// 顶部有 连接/库 两个下拉（Navicat 式）：切换回写 App 的 tab 记录（connId/db/schema 为唯一事实源）
const REL_TYPES = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mssql', 'oracle'];
const SCHEMA_TYPES = ['postgres', 'oracle'];

export default function QueryTab({ connId, connName, db, schema, session, dark, onStatus, qid, qname, initialText, restoreCode, onDirtyChange, onCodeSync, conns = [], sessions = {}, onConnect, onBindChange }) {
  // 恢复关闭的标签页：restoreCode = 关闭时刻的文档内容；initialText 仍是保存基线（二者不同即恢复出脏态）
  const [code, setCode] = useState(
    restoreCode != null ? String(restoreCode) : initialText != null ? String(initialText) : '-- 在此输入 SQL，Ctrl+Enter 运行（选中部分则只运行选中）\n'
  );
  // 未保存基线：文档与基线不一致即“未保存”（保存查询成功后更新基线）
  const [baseline, setBaseline] = useState(
    () => (initialText != null ? String(initialText) : restoreCode != null ? String(restoreCode) : '-- 在此输入 SQL，Ctrl+Enter 运行（选中部分则只运行选中）\n')
  );
  const [results, setResults] = useState([]);
  const [tabKey, setTabKey] = useState('');
  const [running, setRunning] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [hist, setHist] = useState([]);
  // 历史弹窗范围（v0927.52）：'__all' = 全部连接聚合；其余 = 具体 connId（默认当前连接）
  const [histScope, setHistScope] = useState('');
  // 历史搜索/收藏（v0927.52）：关键词过滤（SQL 文本/连接名）+ 只看收藏；histTick 用于收藏翻转后强制重读 localStorage
  const [histSearch, setHistSearch] = useState('');
  const [histFavOnly, setHistFavOnly] = useState(false);
  const [histTick, setHistTick] = useState(0);
  const [savedId, setSavedId] = useState(qid || '');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const editorRef = useRef(null);
  const [tables, setTables] = useState([]);
  const [exportState, setExportState] = useState(null);
  const [edMenu, setEdMenu] = useState(null); // 编辑器右键菜单 {x, y}
  // 执行计划视图：'tree' 算符树 / 'grid' 原始表格（用户选择跨「解释」保留；解析不出树时自动落表格）
  const [planView, setPlanView] = useState('tree');
  // 结果对比（v0927.52）：results 每次运行整体替换（setResults），跨运行对比必须快照——
  // A 侧 = 固定的基准快照 cmpSnap（跨运行存活），B 侧 = 本次运行选中的结果集 cmpB
  const [cmpOpen, setCmpOpen] = useState(false);
  // 基准多快照（v0927.52）：cmpSnaps 为命名快照数组，cmpAName 指向 A 侧当前使用的快照；
  // 兼容旧语义——cmpSnap 由选中快照派生（null=未固定）
  const [cmpSnaps, setCmpSnaps] = useState([]); // [{name, cols, rows, label, time}]
  const [cmpAName, setCmpAName] = useState('');
  const cmpSnap = cmpSnaps.find((x) => x.name === cmpAName) || null;
  const [snapName, setSnapName] = useState(''); // 存为快照的自定义名（空=自动编号）
  const [cmpB, setCmpB] = useState(0); // B 侧在 dataResults 里的下标
  // 对齐模式（v0927.52）：'pos' 位置逐行对齐（默认，v0927.48 行为）/ 'key' 按同名列对齐（主键 diff）
  const [cmpMode, setCmpMode] = useState('pos');
  const [cmpKey, setCmpKey] = useState('');

  // 编辑器右键菜单的关闭：点菜单外 / ESC（同侧栏 ctx-menu 行为）
  useEffect(() => {
    if (!edMenu) return undefined;
    const onDown = (e) => {
      if (!e.target.closest || !e.target.closest('.ctx-menu')) setEdMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setEdMenu(null);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [edMenu]);

  useEffect(() => {
    dbApi(connId, 'tables', { db, schema })
      .then(setTables)
      .catch(() => setTables([]));
    // 依赖 session：挂载/切连接时自动连接尚未完成会 catch 到空表清单，
    // 连接就绪后（sessions[connId] 出现）必须重拉，否则编辑器表名补全永远为空
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, schema, sessions[connId]]);

  // ---- 连接/库下拉（Navicat 式）----
  const curConn = conns.find((c) => c.id === connId);
  const curType = (curConn || {}).type || '';
  const connOptions = conns
    .filter((c) => REL_TYPES.includes(c.type))
    .map((c) => ({ value: c.id, label: c.name }));
  const isSchemaKind = SCHEMA_TYPES.includes(curType);
  const showDbSelect = REL_TYPES.includes(curType) && curType !== 'sqlite';
  const dbValue = isSchemaKind ? schema : db;
  const dbPlaceholder = isSchemaKind ? '默认架构' : '默认库';
  const [dbOptions, setDbOptions] = useState([]);
  const [dbLoading, setDbLoading] = useState(false);

  // 库/schema 选项来自驱动 treeRoot（已连接才拉；断开时清空）
  useEffect(() => {
    if (!connId || !sessions[connId]) { setDbOptions([]); return undefined; }
    let alive = true;
    setDbLoading(true);
    dbApi(connId, 'treeRoot')
      .then((nodes) => {
        if (!alive) return;
        const names = (nodes || [])
          .filter((n) => n.type === 'db' || n.type === 'schema')
          .map((n) => ({ value: n.name, label: n.name }));
        setDbOptions(names);
      })
      .catch(() => { if (alive) setDbOptions([]); })
      .finally(() => { if (alive) setDbLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, sessions[connId]]);

  // 查询页绑定的连接未打开时自动连接（工具栏直接新建查询 / 下拉切换连接都走这里）
  useEffect(() => {
    if (!connId || sessions[connId]) return undefined;
    const c = conns.find((x) => x.id === connId);
    if (c && onConnect) onConnect(c);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  const switchConn = (id) => {
    if (!id || id === connId) return;
    if (onBindChange) onBindChange({ connId: id, db: '', schema: '' });
  };
  const switchDb = (name) => {
    if (!onBindChange) return;
    if (isSchemaKind) onBindChange({ schema: name || '', db: '' });
    else onBindChange({ db: name || '', schema: '' });
  };

  // 未保存脏状态上报（App 在标签上显示绿点，关闭时提示）
  const dirty = code !== baseline;
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);
  // 文档内容上报（App 存免渲染 ref：关闭入栈时随标签记录带走，恢复时回灌编辑器）
  useEffect(() => {
    if (onCodeSync) onCodeSync(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const run = async (selectedOnly) => {
    if (!connId) {
      message.warning('请先在右上角选择数据库连接');
      return;
    }
    let sqlText = code;
    if (selectedOnly && editorRef.current) {
      const sel = editorRef.current.getSelection();
      if (sel && sel.trim()) sqlText = sel;
    }
    if (!sqlText.trim()) return;
    setRunning(true);
    try {
      const t0 = Date.now();
      const res = await dbApi(connId, 'query', { sqlText, db, schema });
      const elapsed = Date.now() - t0;
      setResults(res);
      const errs = res.filter((r) => r.error);
      const rows = res.reduce((a, r) => a + (r.rowCount || 0), 0);
      // 耗时入史（v0927.52）：成功/失败都记，历史弹窗按阈值标慢
      pushHist(connId, sqlText, elapsed, rows, errs.length === 0);
      onStatus(`查询完成：${res.length} 条语句 · ${errs.length ? errs.length + ' 个错误' : '全部成功'} · ${rows} 行 · ${elapsed}ms`);
      const firstData = res.findIndex((r) => !r.error && r.columns && r.columns.length);
      setTabKey(firstData >= 0 ? 'r' + firstData : 'msg');
      // 语句里可能含 DDL（建/删表）：跑完刷新表名清单，编辑器表名补全保持新鲜
      dbApi(connId, 'tables', { db, schema }).then(setTables).catch(() => {});
    } catch (e) {
      message.error(e.message);
    } finally {
      setRunning(false);
    }
  };

  // 解释（EXPLAIN）：把编辑器第一条语句按方言包装成执行计划查询，结果作为结果集网格展示
  const explainRun = async () => {
    if (!connId) {
      message.warning('请先在右上角选择数据库连接');
      return;
    }
    const sqlText = code;
    if (!sqlText.trim()) return;
    setRunning(true);
    try {
      const t0 = Date.now();
      const r = await dbExplain({ connId, sqlText, db, schema });
      const elapsed = Date.now() - t0;
      const rows = r.rows || [];
      setResults([
        { sql: sqlText.slice(0, 160), command: 'EXPLAIN', columns: r.columns || [], rows, rowCount: r.rowCount != null ? r.rowCount : rows.length, elapsed },
      ]);
      onStatus(`解释完成：${rows.length} 行执行计划 · ${elapsed}ms`);
      setTabKey(r.columns && r.columns.length ? 'r0' : 'msg');
      try { console.log(`DH-EXPLAIN ok rows=${rows.length} cols=${(r.columns || []).length}`); } catch {}
    } catch (e) {
      message.error('解释失败：' + e.message);
      try { console.log(`DH-EXPLAIN fail err=${String(e.message).slice(0, 160)}`); } catch {}
    } finally {
      setRunning(false);
    }
  };

  const fetchColumns = async (tbl) => {
    const clean = String(tbl).replace(/["`]/g, '');
    try {
      const cols = await dbApi(connId, 'columns', { db, schema, table: clean });
      return cols.map((c) => c.name);
    } catch {
      return [];
    }
  };

  const saveViaShortcut = () => {
    setSaveName(qname || '');
    if (savedId) doSave();
    else setSaveOpen(true);
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const item = await queriesApi.save({
        id: savedId || undefined,
        name: (saveName || qname || '未命名查询').trim() || '未命名查询',
        connId,
        db: db || '',
        schema: schema || '',
        text: code,
      });
      setSavedId(item.id);
      setBaseline(code);
      // 回写标签记录（qid/保存名/保存基线文本）：关闭入栈后「恢复关闭的标签页」才能对恢复内容正确计脏
      if (onBindChange) onBindChange({ qid: item.id, qname: item.name, initialText: String(code) });
      message.success(`查询已保存：${item.name}`);
      setSaveOpen(false);
    } catch (e) {
      message.error('保存失败：' + e.message);
    } finally {
      setSaving(false);
    }
  };

  // 执行计划页签主体：树形/表格双视图（树形默认；解析不出树时禁用树形并自动落表格）
  const planBody = (r) => {
    const parsed = parsePlan(r.columns, r.rows || []);
    const showTree = !!parsed && planView === 'tree';
    const cnt = r.rowCount != null ? r.rowCount : (r.rows || []).length;
    return (
      <div className="plan-body">
        <div className="plan-bar">
          <span className="plan-bar-title">
            {'执行计划 · ' + cnt + ' 行' + (parsed ? ' · ' + countPlanNodes(parsed.roots) + ' 节点' + (parsed.format === 'sqlite' ? '（SQLite）' : parsed.format === 'indent' ? '（算符树）' : '（逐行）') : '')}
          </span>
          <Space size={4}>
            <Button size="small" type={showTree ? 'primary' : 'default'} data-dh-q="plan-tree" disabled={!parsed} onClick={() => setPlanView('tree')}>
              树形
            </Button>
            <Button size="small" type={!showTree ? 'primary' : 'default'} data-dh-q="plan-grid" onClick={() => setPlanView('grid')}>
              表格
            </Button>
          </Space>
        </div>
        {showTree ? (
          <PlanTree roots={parsed.roots} />
        ) : (
          <ResultGrid
            columns={r.columns}
            rows={r.rows}
            onExport={() =>
              setExportState({
                title: '导出执行计划',
                name: '执行计划',
                table: '',
                columns: r.columns,
                rows: r.rows,
                hint: '该计划共 ' + cnt + ' 行，全部导出。',
              })
            }
          />
        )}
      </div>
    );
  };

  const items = useMemo(() => {
    const list = [];
    let n = 0;
    for (const r of results) {
      if (!r.error && r.columns && r.columns.length) {
        const k = 'r' + list.length;
        const no = list.length;
        if (r.command === 'EXPLAIN') {
          list.push({ key: k, label: '执行计划 (' + (r.rowCount != null ? r.rowCount : (r.rows || []).length) + ')', children: planBody(r) });
          continue;
        }
        list.push({
          key: k,
          label: `结果${++n} (${r.rowCount})`,
          children: (
            <ResultGrid
              columns={r.columns}
              rows={r.rows}
              onExport={() =>
                setExportState({
                  title: `导出结果${no + 1}`,
                  name: `结果${no + 1}`,
                  table: '',
                  columns: r.columns,
                  rows: r.rows,
                  hint: `该结果集共 ${r.rowCount} 行，全部导出。`,
                })
              }
            />
          ),
        });
      }
    }
    list.push({
      key: 'msg',
      label: `消息${results.length ? ` (${results.length})` : ''}`,
      children: (
        <div className="msg-pane">
          {results.length === 0
            ? '尚无输出。'
            : results.map((r, i) =>
                r.error ? (
                  <div key={i} className="msg err">
                    <span className={'dh-ms ' + msClsOf(r.elapsed || 0)}>✗ [{r.elapsed}ms]</span> {r.sql.slice(0, 200)}{'\n'}  错误：{r.error}
                  </div>
                ) : (
                  <div key={i} className="msg">
                    <span className={'dh-ms ' + msClsOf(r.elapsed || 0)}>✓ [{r.elapsed}ms]</span> {r.command || 'OK'}
                    {r.rowCount ? ` · ${r.rowCount} 行` : ''}
                    {r.info && String(r.info).indexOf('Changed:') === 0 ? '' : ''} {r.sql.slice(0, 160)}
                  </div>
                )
              )}
        </div>
      ),
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, planView]);

  // 结果区导出：'rN' 页签对应第 N 个有数据的结果集（与 items 的 key 规则一致）
  const dataResults = useMemo(
    () => results.filter((r) => !r.error && r.columns && r.columns.length),
    [results]
  );
  // 对比弹窗 B 侧下拉：与结果页签同一套编号（EXPLAIN 占位但不计入 结果N）
  const cmpOptions = useMemo(() => {
    const opts = [];
    let n = 0;
    dataResults.forEach((r, i) => {
      const nm = r.command === 'EXPLAIN' ? '执行计划' : '结果' + (++n);
      opts.push({ value: i, label: nm + '（' + (r.rows || []).length + ' 行）', name: nm });
    });
    return opts;
  }, [dataResults]);
  const activeDataNo = tabKey.startsWith('r') ? Number(tabKey.slice(1)) : -1;
  const activeData = dataResults[activeDataNo];
  const openExport = () =>
    setExportState({
      title: `导出结果${activeDataNo + 1}`,
      name: `结果${activeDataNo + 1}`,
      table: '',
      columns: activeData.columns,
      rows: activeData.rows,
      hint: `该结果集共 ${activeData.rowCount} 行，全部导出。`,
    });

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <Button size="small" type="primary" icon={<CaretRightOutlined />} loading={running} onClick={() => run(false)} data-dh-q="run">
          运行 <small>Ctrl+Enter</small>
        </Button>
        <Button size="small" onClick={() => run(true)}>
          运行选中
        </Button>
        <Button size="small" icon={<NodeIndexOutlined />} loading={running} onClick={explainRun} data-dh-q="explain" title="对编辑器第一条语句生成执行计划（EXPLAIN / SHOWPLAN）">
          解释
        </Button>
        <Button size="small" icon={<ClearOutlined />} onClick={() => editorRef.current && editorRef.current.setValue('')}>
          清空
        </Button>
        <Button
          size="small"
          icon={<HistoryOutlined />}
          onClick={() => {
            setHist(loadHist(connId));
            setHistScope(connId);
            setHistOpen(true);
          }}
        >
          历史
        </Button>
        <Button
          size="small"
          icon={<DiffOutlined />}
          onClick={() => setCmpOpen(true)}
          data-dh-q="cmp"
          title="把当前结果集固定为基准，再运行另一条查询，并排对比差异"
        >
          对比
        </Button>
        <Button
          size="small"
          icon={<SaveOutlined />}
          type={savedId ? 'default' : 'dashed'}
          onClick={saveViaShortcut}
          title="Ctrl+S"
        >
          {savedId ? '保存' : '保存查询'}
        </Button>
        <span className="ctx q-target">
          <Select
            size="small"
            className="q-conn-select"
            showSearch
            optionFilterProp="label"
            placeholder="选择连接"
            value={connId || undefined}
            options={connOptions}
            onChange={switchConn}
            disabled={!onBindChange}
          />
          {showDbSelect && (
            <Select
              size="small"
              className="q-db-select"
              showSearch
              optionFilterProp="label"
              placeholder={dbPlaceholder}
              value={dbValue || undefined}
              options={dbOptions}
              loading={dbLoading}
              onChange={switchDb}
              disabled={!onBindChange}
              notFoundContent={dbLoading ? '加载中…' : '暂无'}
            />
          )}
          {session ? <span className="q-server">{session.serverInfo}</span> : null}
        </span>
      </div>
      <div
        className="query-editor-wrap"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setEdMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <SqlEditor
          ref={editorRef}
          value={code}
          onChange={setCode}
          onRun={() => run(false)}
          onSave={saveViaShortcut}
          dialect={session ? session.type : 'standard'}
          dark={dark}
          tables={tables}
          fetchColumns={fetchColumns}
        />
      </div>
      <div className="query-results">
        <Tabs
          size="small"
          className="main-tabs"
          activeKey={tabKey}
          onChange={setTabKey}
          items={items}
          tabBarStyle={{ margin: 0, padding: '2px 6px' }}
          tabBarExtraContent={{
            right: (
              <Button size="small" icon={<ExportOutlined />} disabled={!activeData} onClick={openExport} title="导出当前结果集">
                导出结果…
              </Button>
            ),
          }}
        />
      </div>
      <ExportModal state={exportState} onClose={() => setExportState(null)} />
      {edMenu &&
        (() => {
          const ed = editorRef.current;
          const selText = ed ? ed.getSelection() : ''; // 仅用于菜单项禁用态
          const canUndo = !!ed && ed.canUndo();
          const canRedo = !!ed && ed.canRedo();
          // 点击时现读选区/文档，直接驱动编辑器（不经 setCode 的属性同步，避免 typingLatch 延迟）
          const transform = (fn) => {
            const e2 = editorRef.current;
            if (!e2) return;
            const cur = e2.getSelection();
            if (cur.trim()) e2.replaceSelection(fn(cur));
            else e2.setValue(fn(e2.getValue()));
            e2.focusEditor();
          };
          const paste = () =>
            navigator.clipboard
              .readText()
              .then((t) => {
                if (t) {
                  ed.replaceSelection(t);
                  ed.focusEditor();
                }
              })
              .catch(() => message.error('粘贴失败：无法读取剪贴板'));
          return (
            <FloatMenu
              x={edMenu.x}
              y={edMenu.y}
              onClose={() => setEdMenu(null)}
              items={[
                { key: 'undo', label: '撤销（Ctrl+Z）', icon: <UndoOutlined />, disabled: !canUndo, onClick: () => { ed.undo(); ed.focusEditor(); } },
                { key: 'redo', label: '重做（Ctrl+Shift+Z）', icon: <RedoOutlined />, disabled: !canRedo, onClick: () => { ed.redo(); ed.focusEditor(); } },
                { type: 'divider' },
                { key: 'run', label: '运行（Ctrl+Enter）', icon: <CaretRightOutlined />, onClick: () => run(false) },
                { key: 'runsel', label: '运行选中', icon: <CaretRightOutlined />, disabled: !selText.trim(), onClick: () => run(true) },
                { type: 'divider' },
                { key: 'fmt', label: '美化 SQL', icon: <FormatPainterOutlined />, onClick: () => transform(formatSql) },
                { key: 'min', label: '压缩 SQL', icon: <ShrinkOutlined />, onClick: () => transform(minifySql) },
                { type: 'divider' },
                { key: 'comment', label: '注释/取消注释', onClick: () => { ed.toggleComment(); ed.focusEditor(); } },
                { key: 'selall', label: '全选', onClick: () => { ed.selectAll(); ed.focusEditor(); } },
                { type: 'divider' },
                { key: 'copy', label: '复制选中', disabled: !selText, onClick: () => copyText(selText).then(() => message.success('已复制')) },
                {
                  key: 'cut',
                  label: '剪切选中',
                  disabled: !selText,
                  onClick: () => copyText(selText).then(() => { ed.replaceSelection(''); ed.focusEditor(); }),
                },
                { key: 'paste', label: '粘贴', onClick: paste },
                { type: 'divider' },
                { key: 'clear', label: '清空编辑器', icon: <ClearOutlined />, onClick: () => editorRef.current && editorRef.current.setValue('') },
                {
                  key: 'save',
                  label: savedId ? '保存查询（Ctrl+S）' : '保存查询…（Ctrl+S）',
                  icon: <SaveOutlined />,
                  onClick: saveViaShortcut,
                },
                { key: 'hist', label: '查询历史', icon: <HistoryOutlined />, onClick: () => { setHist(loadHist(connId)); setHistScope(connId); setHistOpen(true); } },
                { key: 'cmp', label: '结果对比…', icon: <DiffOutlined />, onClick: () => setCmpOpen(true) },
                { key: 'acset', label: '补全设置…', icon: <SettingOutlined />, onClick: () => { try { window.dispatchEvent(new CustomEvent('dh-open-acset')); } catch {} } },
              ]}
            />
          );
        })()}
      <Modal
        open={histOpen}
        title="查询历史（最近 50 条）"
        footer={null}
        onCancel={() => setHistOpen(false)}
        width={720}
      >
        {(() => {
          // 范围数据源（v0927.52）：当前/指定连接读单键，'__all' 跨连接聚合
          const agg = histScope === '__all';
          const rows = agg ? loadHistAll() : loadHist(histScope || connId);
          const scopeKeys = [];
          for (let i = 0; i < localStorage.length; i += 1) {
            const k = localStorage.key(i);
            if (k && k.indexOf('dh_hist_') === 0 && k.slice(8) !== connId) scopeKeys.push(k.slice(8));
          }
          const scopeOptions = [{ value: '__all', label: '全部连接' }].concat(
            [{ value: connId, label: connNameOf(conns, connId) + '（当前）' }],
            scopeKeys.map((cid) => ({ value: cid, label: connNameOf(conns, cid) }))
          );
          const connCnt = agg ? new Set(rows.map((h) => h.connId)).size : 0;
          // 耗时统计（v0927.52）：只统计带 ms 的新版条目；升级前的旧条目无 ms 不计入
          const timed = rows.filter((h) => typeof h.ms === 'number');
          const stats = timed.length
            ? '计时 ' +
              timed.length +
              ' 次 · 平均 ' +
              Math.round(timed.reduce((a, h) => a + h.ms, 0) / timed.length) +
              'ms · 最慢 ' +
              Math.max.apply(null, timed.map((h) => h.ms)) +
              'ms' +
              (agg ? ' · ' + connCnt + ' 个连接' : '')
            : '';
          const clearAll = () =>
            Modal.confirm({
              transitionName: '',
              maskTransitionName: '',
              title: '清空当前连接的查询历史？',
              okText: '清空',
              okType: 'danger',
              cancelText: '取消',
              onOk: () => {
                clearHist(connId);
                setHist([]);
              },
            });
          // 搜索/收藏过滤（v0927.52）：关键词匹配 SQL 文本或行内连接名（聚合视图）；统计口径仍按全量 rows
          // 连接名兜底空串：单连接视图的行没有 connId，connNameOf 会返回 undefined（直接 .toLowerCase() 崩界面）
          const kw = histSearch.trim().toLowerCase();
          const shown = rows.filter(
            (h) =>
              (!kw ||
                String(h.sql || '').toLowerCase().indexOf(kw) >= 0 ||
                String(connNameOf(conns, h.connId) || '').toLowerCase().indexOf(kw) >= 0) &&
              (!histFavOnly || !!h.fav)
          );
          const favFlip = (h) => {
            const cid = h.connId || (histScope && histScope !== '__all' ? histScope : connId);
            setFavOf(cid, h.t, !h.fav);
            setHistTick((x) => x + 1);
          };
          return (
            <div data-dh-hist="list">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span data-dh-hist="scope">
                  <Select
                    size="small"
                    style={{ minWidth: 180 }}
                    value={histScope || connId}
                    options={scopeOptions}
                    onChange={(v) => setHistScope(v)}
                  />
                </span>
                <Input
                  allowClear
                  size="small"
                  placeholder="搜索 SQL"
                  style={{ width: 150 }}
                  value={histSearch}
                  onChange={(e) => setHistSearch(e.target.value)}
                  data-dh-hist="search"
                />
                <Button
                  size="small"
                  type={histFavOnly ? 'primary' : 'default'}
                  data-dh-hist="favonly"
                  onClick={() => setHistFavOnly((v) => !v)}
                >
                  只看收藏
                </Button>
                <span data-dh-hist="stats" className="dh-hist-stats" style={{ marginLeft: 'auto' }}>
                  {stats || (rows.length ? '共 ' + rows.length + ' 条（旧条目无耗时记录）' + (agg ? ' · ' + connCnt + ' 个连接' : '') : '')}
                </span>
                <Button
                  size="small"
                  danger
                  disabled={!rows.length || histScope !== connId}
                  data-dh-hist="clear"
                  onClick={clearAll}
                  title={histScope !== connId ? '切到具体连接后才能清空（聚合视图只读）' : '清空当前连接的查询历史'}
                >
                  清空历史
                </Button>
              </div>
              <div style={{ maxHeight: 420, overflow: 'auto' }}>
                {shown.length === 0 ? (
                  <div style={{ color: '#999', textAlign: 'center', padding: 20 }}>{rows.length ? '无匹配结果' : '暂无历史'}</div>
                ) : (
                  shown.map((h, i) => (
                    <div
                      key={i}
                      data-dh-hist="row"
                      className="msg dh-hist-row"
                      style={{ padding: '4px 6px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer', fontFamily: 'Consolas, monospace', fontSize: 12 }}
                      onClick={() => {
                        if (editorRef.current) editorRef.current.setValue(h.sql);
                        setHistOpen(false);
                      }}
                      title="点击载入编辑器"
                    >
                      <span
                        data-dh-hist="fav"
                        className={'dh-hist-fav' + (h.fav ? ' on' : '')}
                        onClick={(e) => {
                          e.stopPropagation();
                          favFlip(h);
                        }}
                        title={h.fav ? '取消收藏' : '收藏'}
                      >
                        {h.fav ? '★' : '☆'}
                      </span>
                      <span style={{ color: '#999', marginRight: 8 }}>{new Date(h.t).toLocaleString()}</span>
                      {agg ? <span data-dh-hist="conn" className="dh-hist-conn">{connNameOf(conns, h.connId)}</span> : null}
                      {h.ok === false ? <span className="dh-hist-err">✗ 失败</span> : null}
                      {typeof h.ms === 'number' ? (
                        <span data-dh-hist="ms" className={'dh-hist-ms ' + msClsOf(h.ms)} style={{ marginRight: 8 }}>
                          {h.ms}ms{h.ms >= SLOW_MS ? ' · 慢' : ''}
                          {typeof h.rows === 'number' && h.rows ? ' · ' + h.rows + ' 行' : ''}
                        </span>
                      ) : null}
                      {h.sql.replace(/\s+/g, ' ').slice(0, 120)}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
      {/* v0927.52 结果对比：固定基准（A，跨运行快照）× 当前结果（B，本次运行结果集）并排 diff */}
      <Modal
        open={cmpOpen}
        title="结果对比"
        footer={null}
        onCancel={() => setCmpOpen(false)}
        width={1080}
        transitionName=""
        maskTransitionName=""
        maskClosable={false}
      >
        {(() => {
          const curB = dataResults.length ? Math.min(cmpB, dataResults.length - 1) : -1;
          const bR = curB >= 0 ? dataResults[curB] : null;
          const bOpt = cmpOptions.find((o) => o.value === curB);
          const ra = cmpSnap || { cols: [], rows: [] };
          const rb = bR ? { cols: bR.columns || [], rows: bR.rows || [] } : { cols: [], rows: [] };
          const commonCols = ra.cols.filter((cA) => rb.cols.some((cB) => String(cB) === String(cA))).map(String);
          const keyMode = cmpMode === 'key' && !!cmpSnap && !!bR && commonCols.length > 0;
          const keyCol = keyMode ? (commonCols.indexOf(cmpKey) >= 0 ? cmpKey : commonCols[0]) : '';
          // pairs：每行 {a, b, aSt, bSt} —— 两侧行数组（或 null）+ 各自按本侧列的状态 ''/'diff'/'miss'
          // 状态即渲染语义：本侧缺格 = 'miss'（灰 '—'）；本侧有值且格对有差异（含对侧缺格）= 'diff'（高亮）
          const pairs = [];
          let diffCnt = 0;
          if (keyMode) {
            const buildMap = (src) => {
              const m = new Map();
              const ki = src.cols.findIndex((c) => String(c) === keyCol);
              (src.rows || []).forEach((row) => {
                const v = ki >= 0 && row[ki] != null ? String(row[ki]) : '';
                if (!m.has(v)) m.set(v, []);
                m.get(v).push(row);
              });
              return m;
            };
            const mA = buildMap(ra);
            const mB = buildMap(rb);
            // 归并键序：A 的键序在前，仅 B 有的键追加（重复键按键内出现序配对）
            const keyOrder = [...mA.keys(), ...[...mB.keys()].filter((k) => !mA.has(k))];
            for (const k of keyOrder) {
              const la = mA.get(k) || [];
              const lb = mB.get(k) || [];
              for (let j = 0; j < Math.max(la.length, lb.length); j += 1) {
                const a = la[j] || null;
                const b = lb[j] || null;
                const aSt = ra.cols.map(() => '');
                const bSt = rb.cols.map(() => '');
                if (!a || !b) {
                  // 单侧行：存在侧整行按差异高亮，缺侧整行灰显
                  if (a) aSt.fill('diff'); else aSt.fill('miss');
                  if (b) bSt.fill('diff'); else bSt.fill('miss');
                  diffCnt += a ? ra.cols.length : rb.cols.length;
                } else {
                  for (const cn of commonCols) {
                    const ia = ra.cols.findIndex((c) => String(c) === cn);
                    const ib = rb.cols.findIndex((c) => String(c) === cn);
                    if (String(a[ia]) !== String(b[ib])) {
                      aSt[ia] = 'diff';
                      bSt[ib] = 'diff';
                      diffCnt += 1;
                    }
                  }
                }
                pairs.push({ a, b, aSt, bSt });
              }
            }
          } else {
            const nR = Math.max(ra.rows.length, rb.rows.length);
            const nC = Math.max(ra.cols.length, rb.cols.length);
            for (let r = 0; r < nR; r += 1) {
              const a = r < ra.rows.length ? ra.rows[r] : null;
              const b = r < rb.rows.length ? rb.rows[r] : null;
              const aSt = [];
              const bSt = [];
              for (let c = 0; c < nC; c += 1) {
                const hasA = !!a && c < ra.cols.length;
                const hasB = !!b && c < rb.cols.length;
                let st = '';
                if (!hasA || !hasB) st = 'miss';
                else if (String(ra.rows[r][c]) !== String(rb.rows[r][c])) st = 'diff';
                if (st) diffCnt += 1;
                if (c < ra.cols.length) aSt.push(!hasA ? 'miss' : st ? 'diff' : '');
                if (c < rb.cols.length) bSt.push(!hasB ? 'miss' : st ? 'diff' : '');
              }
              pairs.push({ a, b, aSt, bSt });
            }
          }
          const shapeEq = ra.rows.length === rb.rows.length && ra.cols.length === rb.cols.length;
          let stats;
          if (!cmpSnap) stats = '尚未固定基准：先运行查询并点「固定为基准」，再运行要对比的另一条查询';
          else if (!bR) stats = '当前运行无结果集——先运行要对比的另一条查询';
          else if (cmpMode === 'key' && !commonCols.length) stats = '两侧无同名列，无法按键对齐（当前按位置对齐）';
          else if (keyMode) {
            const nBoth = pairs.filter((pr) => pr.a && pr.b).length;
            const onlyA = pairs.filter((pr) => pr.a && !pr.b).length;
            const onlyB = pairs.filter((pr) => !pr.a && pr.b).length;
            stats = '按 ' + keyCol + ' 对齐 · 匹配 ' + nBoth + ' 行 · 仅A ' + onlyA + ' · 仅B ' + onlyB + ' · ' +
              (onlyA === 0 && onlyB === 0 && diffCnt === 0 ? '完全一致' : '不同 ' + diffCnt + ' 格');
          } else {
            stats = '基准 ' + ra.rows.length + ' 行 × ' + ra.cols.length + ' 列 · 当前 ' + rb.rows.length + ' 行 × ' + rb.cols.length + ' 列 · ' +
              (shapeEq && diffCnt === 0
                ? '完全一致'
                : '不同 ' + diffCnt + ' 格' +
                  (ra.rows.length !== rb.rows.length ? '（行数不同）' : '') +
                  (ra.cols.length !== rb.cols.length ? '（列数不同）' : ''));
          }
          // 行渲染：pairs 驱动两侧表格（缺行侧整行灰 '—'，值差异格/单侧存在行高亮）。
          // 位置对齐按最大列数渲染（短侧缺列画灰 '—'，保持列对齐）；按键对齐按各侧自身列（仅共同列比对）
          const side = (which) => {
            const src = which === 'A' ? ra : rb;
            const stKey = which === 'A' ? 'aSt' : 'bSt';
            const cellCount = keyMode ? src.cols.length : Math.max(ra.cols.length, rb.cols.length);
            const cap = which === 'A'
              ? (cmpSnap ? '基准 · ' + cmpSnap.name + ' · ' + cmpSnap.label + '（' + ra.rows.length + ' 行，' + cmpSnap.time + ' 固定）' : '基准 · 未固定')
              : (bR ? '当前 · ' + (bOpt ? bOpt.name : '结果集') + '（' + rb.rows.length + ' 行）' : '当前 · 无结果集');
            return (
              <div className="dh-cmp-side" data-dh-cmp={'side' + which}>
                <div className="dh-cmp-cap" data-dh-cmp={'cap' + which}>{cap}</div>
                {src.cols.length || src.rows.length ? (
                  <table className="dh-cmp-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        {src.cols.map((c, i) => <th key={i}>{c == null ? '' : String(c)}</th>)}
                        {Array.from({ length: Math.max(cellCount - src.cols.length, 0) }, (_, i) => <th key={'x' + i} className="dh-diff-miss">—</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {pairs.map((pr, r) => {
                        const row = which === 'A' ? pr.a : pr.b;
                        const sts = pr[stKey];
                        return (
                          <tr key={r}>
                            <td>{r + 1}</td>
                            {Array.from({ length: cellCount }, (_, i) => {
                              if (!row || i >= src.cols.length) return <td key={i} className="dh-diff-miss">—</td>;
                              const v = row[i];
                              const txt = v == null ? '' : String(v);
                              return sts[i] ? <td key={i} className={sts[i] === 'miss' ? 'dh-diff-miss' : 'dh-diff-cell'}>{txt}</td> : <td key={i}>{txt}</td>;
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="dh-cmp-empty">（空）</div>
                )}
              </div>
            );
          };
          // 快照管理（v0927.52）：固定为基准 = 存快照并选为 A 侧；可命名多存、切换、删除
          const addSnap = (raw) => {
            if (!bR) return;
            const base = String(raw || '').trim();
            let nm = base;
            if (!nm) {
              let i = 1;
              while (cmpSnaps.some((x) => x.name === '快照' + i)) i += 1;
              nm = '快照' + i;
            } else if (cmpSnaps.some((x) => x.name === nm)) {
              let i = 2;
              while (cmpSnaps.some((x) => x.name === nm + '-' + i)) i += 1;
              nm = nm + '-' + i;
            }
            setCmpSnaps([
              ...cmpSnaps,
              {
                name: nm,
                cols: (bR.columns || []).slice(),
                rows: (bR.rows || []).map((row) => (Array.isArray(row) ? row.slice() : { ...row })),
                label: bOpt ? bOpt.name : '结果集',
                time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              },
            ]);
            setCmpAName(nm);
            setSnapName('');
          };
          const delSnap = () => {
            if (!cmpSnap) return;
            const rest = cmpSnaps.filter((x) => x.name !== cmpAName);
            setCmpSnaps(rest);
            setCmpAName(rest.length ? rest[rest.length - 1].name : '');
          };
          return (
            <div data-dh-cmp="modal">
              <div className="dh-cmp-bar">
                <Button size="small" data-dh-cmp="pin" disabled={!bR} onClick={() => addSnap('')}>
                  固定为基准
                </Button>
                <span data-dh-cmp="selB">
                  <Select
                    size="small"
                    style={{ minWidth: 150 }}
                    value={curB >= 0 ? curB : undefined}
                    options={cmpOptions}
                    onChange={(v) => setCmpB(v)}
                    disabled={!bR || dataResults.length < 2}
                    placeholder="当前结果"
                  />
                </span>
                <span data-dh-cmp="mode">
                  <Select
                    size="small"
                    style={{ minWidth: 104 }}
                    value={cmpMode}
                    options={[{ value: 'pos', label: '位置对齐' }, { value: 'key', label: '按键对齐' }]}
                    onChange={(v) => setCmpMode(v)}
                  />
                </span>
                {cmpMode === 'key' && commonCols.length ? (
                  <span data-dh-cmp="keysel">
                    <Select
                      size="small"
                      style={{ minWidth: 100 }}
                      value={keyCol}
                      options={commonCols.map((c) => ({ value: c, label: c }))}
                      onChange={(v) => setCmpKey(v)}
                    />
                  </span>
                ) : null}
                <span data-dh-cmp="snap">
                  <Select
                    size="small"
                    style={{ minWidth: 140 }}
                    value={cmpAName || undefined}
                    options={cmpSnaps.map((x) => ({ value: x.name, label: x.name + '（' + x.label + '）' }))}
                    onChange={(v) => setCmpAName(v)}
                    placeholder="基准快照"
                    disabled={!cmpSnaps.length}
                  />
                </span>
                <Input
                  size="small"
                  style={{ width: 110 }}
                  placeholder="快照名"
                  value={snapName}
                  onChange={(e) => setSnapName(e.target.value)}
                  onPressEnter={() => addSnap(snapName)}
                  data-dh-cmp="snapname"
                />
                <Button size="small" data-dh-cmp="snapadd" disabled={!bR} onClick={() => addSnap(snapName)}>
                  存为快照
                </Button>
                <Button size="small" danger disabled={!cmpSnap} data-dh-cmp="snapdel" onClick={delSnap}>
                  删除快照
                </Button>
                <span data-dh-cmp="stats" className="dh-cmp-stats">{stats}</span>
              </div>
              <div className="dh-cmp-wrap">{side('A')}{side('B')}</div>
            </div>
          );
        })()}
      </Modal>
      <Modal
        open={saveOpen}
        title="保存查询"
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setSaveOpen(false)}
        onOk={() => (saveName.trim() ? doSave() : message.warning('请输入名称'))}
      >
        <Input
          autoFocus
          placeholder="查询名称，例如：每日订单统计"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onPressEnter={() => (saveName.trim() ? doSave() : message.warning('请输入名称'))}
        />
        <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
          保存后可在侧栏「查询列表」中随时打开；连接/库/当前 SQL 一并记录。
        </div>
      </Modal>
    </div>
  );
}
