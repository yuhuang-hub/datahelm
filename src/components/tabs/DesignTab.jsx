import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Select, Space, Table, Tabs, message } from 'antd';
import { CloseOutlined, DeleteOutlined, DownOutlined, EditOutlined, EyeOutlined, HolderOutlined, MinusOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UpOutlined } from '@ant-design/icons';
import { dbApi } from '../../api';
import { useGridHeight } from '../../format';

const TYPES = [
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
  'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'BOOLEAN',
  'BLOB', 'JSON', 'UUID', 'SERIAL', 'BIGSERIAL',
];
const TYPE_OPTIONS = TYPES.map((t) => ({ value: t }));
const REF_ACTIONS = ['', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'];
const REF_ACTIONS_MSSQL = ['', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

let fieldSeq = 0;
let rowSeq = 0;

const blankCol = () => ({
  key: ++fieldSeq,
  name: '',
  dataType: 'VARCHAR',
  length: 255,
  scale: '',
  nullable: true,
  pk: false,
  autoInc: false,
  defaultValue: '',
  comment: '',
  origName: '',
});

// 编辑行 -> 规范数据（去 key，trim）
const stripRow = (r) => {
  const { key, ...rest } = r;
  return rest;
};

// 表设计器：字段 / 索引 / 外键 / 唯一键 / 检查 / 触发器 / 选项 / 存储 / 注释 / SQL 预览
export default function DesignTab({ connId, connName, db, schema, table, isNew, focus, session, onStatus, onChanged, onClose, onDirtyChange }) {
  const DT = (session && session.type) || '';
  const isMy = DT === 'mysql' || DT === 'mariadb';
  const isPg = DT === 'postgres';
  const isMs = DT === 'mssql';
  const isLite = DT === 'sqlite';
  const objSupported = isMy || isPg || isMs || isLite;

  const [cols, setCols] = useState(isNew ? [blankCol()] : []);
  const [before, setBefore] = useState([]); // 原始 colMeta
  const [tableName, setTableName] = useState(table || '');
  const [sel, setSel] = useState([]);
  const [applying, setApplying] = useState(false);
  const [gridRef, gridH] = useGridHeight(120);
  const [activeTab, setActiveTab] = useState('fields');
  // 行拖拽排序：armed=按住手柄才允许拖（避免与单元格内选取文本冲突）
  const [armed, setArmed] = useState(false);
  const [dragging, setDragging] = useState(null); // 拖动中行的 key
  const [over, setOver] = useState(null); // { key, pos: 'above'|'below' }
  const dragKeyRef = useRef(null);

  // ---- 索引 / 唯一键 / 外键 / 检查 / 触发器 / 表信息 ----
  const [idxs, setIdxs] = useState([]);
  const [idxsBefore, setIdxsBefore] = useState([]);
  const [uqs, setUqs] = useState([]);
  const [uqsBefore, setUqsBefore] = useState([]);
  const [fks, setFks] = useState([]);
  const [fksBefore, setFksBefore] = useState([]);
  const [cks, setCks] = useState([]);
  const [cksBefore, setCksBefore] = useState([]);
  const [trigs, setTrigs] = useState([]);
  const [info, setInfo] = useState({ comment: '', options: {} });
  const [infoBefore, setInfoBefore] = useState({ comment: '', options: {} });
  const [tables, setTables] = useState([]); // 外键引用表候选
  const refColsRef = useRef({}); // 引用表(含跨 schema) -> 列名[]；变更计数仅用于触发重渲染刷新 options
  const [, setRefColsVer] = useState(0);
  const [sqlPreview, setSqlPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState('');
  // 他表引用本表的外键（v0927.52 重建提示）：null=未检测/无重建，[]=无引用，[...]=引用清单
  const [fkRefs, setFkRefs] = useState(null);
  const [trigModal, setTrigModal] = useState(null); // { name, timing, event, body }
  const [trigDdl, setTrigDdl] = useState(null); // { name, text }
  const [trigBusy, setTrigBusy] = useState(false);
  const [idxSelKey, setIdxSelKey] = useState(null); // 索引页选中行（栏位排序面板绑定）
  const [fkSelKey, setFkSelKey] = useState(null); // 外键页选中行（启用/不适用于复制面板绑定）
  const [focusHit, setFocusHit] = useState(null); // 侧边栏明细行「编辑」定位命中：{ tab, key }
  // 初次内省完成标记：focus.create 的追加行必须等 reload() 落完，否则会被整体覆盖（挂载即触发的竞态）
  const colsLoadedRef = useRef(false);
  const structLoadedRef = useRef(false);

  const reload = useCallback(() => {
    if (isNew) return;
    dbApi(connId, 'columns', { db, schema, table })
      .then((meta) => {
        setBefore(meta);
        setCols(
          meta.map((m) => ({
            key: ++fieldSeq,
            name: m.name,
            dataType: (m.dataType || 'VARCHAR').toUpperCase(),
            length: m.length == null ? '' : m.length,
            scale: m.scale == null ? '' : m.scale,
            nullable: !!m.nullable,
            pk: !!m.pk,
            autoInc: !!m.autoInc,
            defaultValue: m.defaultValue == null ? '' : String(m.defaultValue),
            comment: m.comment || '',
            origName: m.name,
          }))
        );
        colsLoadedRef.current = true;
      })
      .catch((e) => { colsLoadedRef.current = true; message.error(e.message); });
    if (!objSupported) { structLoadedRef.current = true; return; }
    const args = { db, schema, table };
    const safe = (p) => p.catch((e) => { console.log('DH-DESIGN 内省失败 ' + e.message); return null; });
    Promise.all([
      safe(dbApi(connId, 'indexes', args)),
      isPg || isMs ? safe(dbApi(connId, 'uniques', args)) : Promise.resolve(null),
      safe(dbApi(connId, 'fkeys', args)),
      safe(dbApi(connId, 'checks', args)),
      safe(dbApi(connId, 'tableInfo', args)),
      safe(dbApi(connId, 'triggers', args)),
    ]).then(([idxRes, uqRes, fkRes, ckRes, infoRes, trigRes]) => {
      const idxFrom = (x) => ({
        name: x.name,
        columns: (x.columns || []).map(String),
        dirs: (x.columns || []).map((_, i) => (String((x.dirs || [])[i] || '').toUpperCase() === 'DESC' ? 'DESC' : '')),
        type: isLite ? '' : String(x.type || '').toUpperCase(),
        unique: !!x.unique,
        comment: String(x.comment || ''),
        where: String(x.where || ''),
      });
      let iList = [];
      let uList = [];
      if (isLite || isMy) {
        // sqlite/mysql：唯一索引即唯一键，索引/唯一键同源自 indexes()
        const list = (idxRes || []).filter((x) => String(x.origin || 'c') !== 'pk');
        iList = list.filter((x) => !x.unique).map(idxFrom);
        uList = list
          .filter((x) => x.unique)
          .map((x) => ({ name: x.name, columns: (x.columns || []).map(String), clustered: false, comment: isLite ? '' : String(x.comment || '') }));
      } else {
        iList = (idxRes || []).map(idxFrom);
        uList = (uqRes || []).map((x) => ({ name: x.name, columns: (x.columns || []).map(String), clustered: !!x.clustered, comment: String(x.comment || '') }));
      }
      setIdxsBefore(iList);
      setIdxs(iList.map((x) => ({ key: ++rowSeq, ...x, columns: [...x.columns], dirs: [...x.dirs] })));
      setUqsBefore(uList);
      setUqs(uList.map((x) => ({ key: ++rowSeq, ...x, columns: [...x.columns] })));
      const fList = (fkRes || []).map((x) => ({
        name: x.name,
        columns: (x.columns || []).map(String),
        refSchema: String(x.refSchema || ''),
        refTable: x.refTable || '',
        refColumns: (x.refColumns || []).map(String),
        onDelete: x.onDelete || '',
        onUpdate: x.onUpdate || '',
        comment: String(x.comment || ''),
        enabled: x.enabled !== false,
        notForReplication: !!x.notForReplication,
      }));
      setFksBefore(fList);
      setFks(fList.map((x) => ({ key: ++rowSeq, ...x, columns: [...x.columns], refColumns: [...x.refColumns] })));
      setIdxSelKey(null);
      setFkSelKey(null);
      const cList = (ckRes || []).map((x) => ({
        name: x.name || '',
        expr: x.expr || '',
        comment: isLite || isMy ? '' : String(x.comment || ''),
        enabled: isMs ? x.enabled !== false : true,
        notForReplication: isMs ? !!x.notForReplication : false,
      }));
      setCksBefore(cList);
      setCks(cList.map((x) => ({ key: ++rowSeq, ...x })));
      const inf = infoRes || { comment: '', options: {} };
      setInfoBefore(inf);
      setInfo({ comment: inf.comment || '', options: { ...(inf.options || {}) } });
      setTrigs(trigRes || []);
      structLoadedRef.current = true;
    });
  }, [connId, db, schema, table, isNew, objSupported, isPg, isMs, isLite, isMy]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 侧边栏结构明细行「编辑」定位：切到对应分区并高亮该行（focus.ts 保证同一行重复点击也能重新触发）；
  // 分组右键「新建X」（focus.create、无 name）：切分区并追加一行空白行
  const focusSig = useRef('');
  useEffect(() => {
    if (!focus) return;
    const tab = { col: 'fields', idx: 'idx', fk: 'fk', uq: 'uq', ck: 'ck', tg: 'trig' }[focus.kind];
    if (!tab) return;
    if (focus.create) {
      // 初次内省未完成：挂起（reload 的 setState 会重放本 effect），完成后再追加，避免新行被整体覆盖
      if (!(colsLoadedRef.current && structLoadedRef.current)) return;
      const sig = `new:${focus.kind}:${focus.ts || ''}`;
      if (focusSig.current === sig) return;
      focusSig.current = sig;
      setActiveTab(tab);
      const add = { col: addCol, idx: addIdx, fk: addFk, uq: addUq, ck: addCk }[focus.kind];
      if (add) add();
      return;
    }
    if (!focus.name) return;
    const sig = `${focus.kind}:${focus.name}:${focus.ts || ''}`;
    if (focusSig.current === sig) return;
    const rows = { col: cols, idx: idxs, fk: fks, uq: uqs, ck: cks, tg: trigs }[focus.kind] || [];
    const hit = rows.find((r) => r.name === focus.name);
    if (!hit) return;
    focusSig.current = sig;
    setActiveTab(tab);
    setFocusHit({ tab, key: hit.key || hit.name });
    if (focus.kind === 'idx') setIdxSelKey(hit.key);
    if (focus.kind === 'fk') setFkSelKey(hit.key);
  }, [focus, cols, idxs, fks, uqs, cks, trigs]);

  useEffect(() => {
    if (!focusHit) return;
    const t = setTimeout(() => {
      const el = document.querySelector('.design-tabs .row-focus');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }, 150);
    return () => clearTimeout(t);
  }, [focusHit]);

  useEffect(() => {
    dbApi(connId, 'tables', { db, schema })
      .then((list) => setTables((list || []).map((t) => String(t))))
      .catch(() => setTables([]));
  }, [connId, db, schema]);

  const upd = (key, patch) => setCols((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  const addCol = () => setCols((prev) => [...prev, blankCol()]);
  // 各分区「添加」行工厂：侧栏分组右键「新建X」定位进来时复用（同一空白行形状）
  const addIdx = () => setIdxs((p) => [...p, { key: ++rowSeq, name: '', columns: [], dirs: [], type: isMs ? 'NONCLUSTERED' : '', unique: false, comment: '', where: '' }]);
  const addFk = () => setFks((p) => [...p, { key: ++rowSeq, name: '', columns: [], refSchema: '', refTable: '', refColumns: [], onDelete: '', onUpdate: '', comment: '', enabled: true, notForReplication: false }]);
  const addUq = () => setUqs((p) => [...p, { key: ++rowSeq, name: '', columns: [], clustered: false, comment: '' }]);
  const addCk = () => setCks((p) => [...p, { key: ++rowSeq, name: '', expr: '', comment: '', enabled: true, notForReplication: false }]);
  const delCols = () => {
    setCols((prev) => prev.filter((c) => !sel.includes(c.key)));
    setSel([]);
  };

  // 拖拽落点：把拖动行移动到目标行上/下方
  const dropAt = (fromKey, toKey, pos) => {
    setCols((prev) => {
      const fi = prev.findIndex((c) => c.key === fromKey);
      if (fi < 0) return prev;
      const arr = [...prev];
      const [moved] = arr.splice(fi, 1);
      let ti = arr.findIndex((c) => c.key === toKey);
      if (ti < 0) return prev;
      arr.splice(pos === 'above' ? ti : ti + 1, 0, moved);
      return arr;
    });
  };
  const endDrag = () => {
    dragKeyRef.current = null;
    setDragging(null);
    setOver(null);
    setArmed(false);
  };
  const onRow = (r) => ({
    draggable: armed,
    onDragStart: (e) => {
      if (dragKeyRef.current == null && !armed) {
        e.preventDefault();
        return;
      }
      dragKeyRef.current = r.key;
      setDragging(r.key);
      try {
        e.dataTransfer.setData('text/plain', String(r.key)); // Chromium 必须 setData 才会启动拖拽
        e.dataTransfer.effectAllowed = 'move';
      } catch {}
    },
    onDragOver: (e) => {
      if (dragKeyRef.current == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
      if (!over || over.key !== r.key || over.pos !== pos) setOver({ key: r.key, pos });
    },
    onDrop: (e) => {
      e.preventDefault();
      const from = dragKeyRef.current;
      if (from != null && from !== r.key) {
        const rect = e.currentTarget.getBoundingClientRect();
        dropAt(from, r.key, e.clientY < rect.top + rect.height / 2 ? 'above' : 'below');
      }
      endDrag();
    },
    onDragEnd: endDrag,
    onMouseUp: () => setArmed(false),
  });

  // ---- 脏状态：与加载时的快照逐项比较 ----
  const normColUi = (c) => ({
    name: String(c.name || '').trim(),
    dataType: String(c.dataType || '').trim().toUpperCase() || 'VARCHAR',
    length: c.length === '' || c.length == null ? '' : String(c.length),
    scale: c.scale === '' || c.scale == null ? '' : String(c.scale),
    nullable: !!c.nullable,
    pk: !!c.pk,
    autoInc: !!c.autoInc,
    defaultValue: String(c.defaultValue == null ? '' : c.defaultValue).trim(),
    comment: String(c.comment || ''),
  });
  const beforeNorm = useMemo(
    () =>
      before.map((m) =>
        normColUi({
          name: m.name,
          dataType: m.dataType,
          length: m.length,
          scale: m.scale,
          nullable: m.nullable,
          pk: m.pk,
          autoInc: m.autoInc,
          defaultValue: m.defaultValue,
          comment: m.comment,
        })
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [before]
  );
  const sigList = (arr, sig) => arr.map(sig).sort().join(';\u0001');
  const idxSig = (x) =>
    JSON.stringify([
      String(x.name || '').trim(),
      (x.columns || []).map(String),
      (x.columns || []).map((_, i) => (String((x.dirs || [])[i] || '') === 'DESC' ? 'DESC' : '')),
      String(x.type || '').trim().toUpperCase(),
      !!x.unique,
      String(x.comment || ''),
      String(x.where || '').replace(/\s+/g, ' ').trim(),
    ]);
  const uqSig = (x) =>
    JSON.stringify([String(x.name || '').trim(), (x.columns || []).map(String), !!x.clustered, String(x.comment || '')]);
  const fkSig = (x) =>
    JSON.stringify([
      String(x.name || '').trim(),
      (x.columns || []).map(String),
      String(x.refSchema || '').trim(),
      String(x.refTable || '').trim(),
      (x.refColumns || []).map(String),
      String(x.onDelete || '').toUpperCase(),
      String(x.onUpdate || '').toUpperCase(),
      String(x.comment || ''),
      x.enabled !== false,
      !!x.notForReplication,
    ]);
  const ckSig = (x) =>
    JSON.stringify([
      String(x.name || '').trim(),
      String(x.expr || '').replace(/\s+/g, ' ').trim(),
      String(x.comment || ''),
      x.enabled !== false,
      !!x.notForReplication,
    ]);
  const normOpts = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      const s = String(v == null ? '' : v).trim();
      if (s !== '') out[k] = s;
    }
    return out;
  };

  const dirty = useMemo(() => {
    if (isNew) return true;
    if (tableName.trim() !== String(table || '')) return true;
    if (JSON.stringify(cols.map(normColUi)) !== JSON.stringify(beforeNorm)) return true;
    if (sigList(idxs.map(stripRow), idxSig) !== sigList(idxsBefore, idxSig)) return true;
    if (sigList(uqs.map(stripRow), uqSig) !== sigList(uqsBefore, uqSig)) return true;
    if (sigList(fks.map(stripRow), fkSig) !== sigList(fksBefore, fkSig)) return true;
    if (sigList(cks.map(stripRow), ckSig) !== sigList(cksBefore, ckSig)) return true;
    if (JSON.stringify({ comment: String(info.comment || ''), options: normOpts(info.options) }) !== JSON.stringify({ comment: String(infoBefore.comment || ''), options: normOpts(infoBefore.options) }))
      return true;
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, tableName, table, cols, beforeNorm, idxs, idxsBefore, uqs, uqsBefore, fks, fksBefore, cks, cksBefore, info, infoBefore]);

  useEffect(() => {
    if (onDirtyChange) onDirtyChange(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const validate = () => {
    if (!tableName.trim()) return '请输入表名';
    const names = new Set();
    for (const c of cols) {
      if (!c.name.trim()) return '存在未命名字段';
      if (names.has(c.name.trim())) return `字段名重复：${c.name}`;
      names.add(c.name.trim());
    }
    if (!cols.length) return '至少需要一个字段';
    for (const r of [...idxs, ...uqs]) {
      if (!String(r.name || '').trim()) return '索引/唯一键存在未命名项';
      if (!(r.columns || []).length) return `「${r.name}」未选择列`;
      if ((r.columns || []).some((c) => !String(c).trim())) return `索引「${r.name}」存在空的表达式键`;
    }
    for (const r of fks) {
      if (!String(r.name || '').trim()) return '外键存在未命名项';
      if (!(r.columns || []).length) return `外键「${r.name}」未选择本表列`;
      if (!String(r.refTable || '').trim()) return `外键「${r.name}」未选择引用表`;
      if (!(r.refColumns || []).length) return `外键「${r.name}」未选择引用列`;
    }
    for (const r of cks) {
      if (!String(r.name || '').trim()) return '检查约束存在未命名项';
      if (!String(r.expr || '').trim()) return `检查约束「${r.name}」缺少表达式`;
    }
    return null;
  };

  const buildSpec = () => ({
    db,
    schema,
    table,
    newName: tableName.trim(),
    before,
    after: cols.map((c) => ({ ...c, name: c.name.trim(), dataType: String(c.dataType || '').trim().toUpperCase() || 'VARCHAR' })),
    indexesBefore: idxsBefore,
    indexesAfter: idxs.map(stripRow),
    uniquesBefore: uqsBefore,
    uniquesAfter: uqs.map(stripRow),
    fkeysBefore: fksBefore,
    fkeysAfter: fks.map(stripRow),
    checksBefore: cksBefore,
    checksAfter: cks.map(stripRow),
    infoBefore,
    options: normOpts(info.options),
    comment: String(info.comment == null ? '' : info.comment),
  });

  const save = async () => {
    const err = validate();
    if (err) {
      message.warning(err);
      return;
    }
    const spec = buildSpec();
    try {
      if (isNew) {
        await dbApi(connId, 'createTable', {
          db,
          schema,
          name: spec.newName,
          cols: spec.after,
          comment: spec.comment,
          indexesAfter: spec.indexesAfter,
          uniquesAfter: spec.uniquesAfter,
          fkeysAfter: spec.fkeysAfter,
          checksAfter: spec.checksAfter,
        });
        message.success(`表 ${spec.newName} 已创建`);
        onStatus(`已创建表 ${spec.newName}`);
        onChanged();
        onClose();
      } else {
        const sqls = await dbApi(connId, 'alterScript', spec);
        if (!sqls.length) {
          message.info('没有检测到变更');
          return;
        }
        await applyPreview(); // 直接执行变更，不再跳 SQL 预览
      }
    } catch (e) {
      message.error(e.message);
    }
  };

  // SQL 预览刷新（v0927.52）：生成语句里出现 __rebuild 标记（列序变更走重建表）时，
  // 顺带查他表引用本表的外键，在预览区上方给限制提示（仅提示不阻断——执行失败会自然报错）
  const refreshPreview = () =>
    dbApi(connId, 'alterScript', buildSpec())
      .then((sqls) => {
        setSqlPreview(sqls);
        setPreviewErr('');
        setFkRefs(null);
        if ((sqls || []).some((s) => String(s).indexOf('__rebuild') >= 0)) {
          dbApi(connId, 'inFkeys', { db, schema, table })
            .then((r) => setFkRefs(r || []))
            .catch(() => setFkRefs(null));
        }
      })
      .catch((e) => setPreviewErr(e.message));

  // SQL 预览页签激活时刷新（只读预览；「保存」直接执行不再跳转）
  useEffect(() => {
    if (activeTab !== 'sql' || isNew) return undefined;
    refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const applyPreview = async () => {
    setApplying(true);
    try {
      const spec = buildSpec();
      const r = await dbApi(connId, 'applyAlter', spec);
      message.success(`已执行 ${r.executed} 条语句`);
      onStatus(`表 ${spec.newName} 结构已更新（${r.executed} 条语句）`);
      onChanged();
      if (spec.newName !== spec.table) onClose(); // 表已改名，旧标签关闭
      else {
        reload();
        setActiveTab('fields');
      }
    } catch (e) {
      message.error(`执行失败：${e.message}`);
    } finally {
      setApplying(false);
    }
  };

  // ---- 触发器 ----
  const loadTriggers = () => {
    dbApi(connId, 'triggers', { db, schema, table })
      .then((list) => setTrigs(list || []))
      .catch((e) => message.error(e.message));
  };
  const refColKeyOf = (r) => {
    const rs = String(r.refSchema || '').trim();
    return (rs ? rs + '\u0001' : '') + String(r.refTable || '').trim();
  };
  const ensureRefCols = async (tname, refSchema) => {
    const t = String(tname || '').trim();
    const key = (String(refSchema || '').trim() ? String(refSchema).trim() + '\u0001' : '') + t;
    if (!t || refColsRef.current[key]) return refColsRef.current[key] || [];
    try {
      const args = { table: t };
      if (isMy) args.db = String(refSchema || '').trim() || db;
      if (isPg || isMs) args.schema = String(refSchema || '').trim() || schema;
      if (isMs) args.db = db; // mssql 内省按 TABLE_catalog 过滤，缺 db 查不到列
      const meta = await dbApi(connId, 'columns', args);
      refColsRef.current[key] = meta.map((m) => m.name);
    } catch {
      refColsRef.current[key] = [];
    }
    setRefColsVer((v) => v + 1);
    return refColsRef.current[key];
  };
  useEffect(() => {
    fks.forEach((f) => {
      if (f.refTable) ensureRefCols(f.refTable, f.refSchema);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fks]);

  const trigTimings = isMs ? ['AFTER', 'INSTEAD OF'] : isMy ? ['BEFORE', 'AFTER'] : ['BEFORE', 'AFTER', 'INSTEAD OF'];
  const trigTemplate = (name, timing, event) => {
    const tn = tableName || table || '';
    const nm = String(name || 'trig_1').trim();
    // 模板体里放一条合法占位语句（空 BEGIN…END / 仅注释在各库都不合法）
    if (isLite) return `CREATE TRIGGER "${nm}" ${timing} ${event} ON "${tn}"\nFOR EACH ROW\nBEGIN\n  SELECT 1; -- TODO: 替换为触发器逻辑\nEND;`;
    if (isMy) return `DELIMITER $$\nCREATE TRIGGER \`${nm}\` ${timing} ${event} ON \`${tn}\`\nFOR EACH ROW\nBEGIN\n  SET @x = 1; -- TODO: 替换为触发器逻辑\nEND$$\nDELIMITER ;`;
    if (isPg) return `CREATE OR REPLACE FUNCTION ${nm}_fn()\nRETURNS trigger AS $$\nBEGIN\n  -- TODO: 触发器逻辑（DELETE 触发器请 RETURN OLD）\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;\n\nCREATE TRIGGER ${nm}\n${timing} ${event} ON ${tn}\nFOR EACH ROW EXECUTE FUNCTION ${nm}_fn();`;
    return `CREATE TRIGGER [${nm}] ON [${tn}]\n${timing} ${event}\nAS\nBEGIN\n  SET NOCOUNT ON; -- TODO: 替换为触发器逻辑\nEND;`;
  };
  const runTriggerSql = async () => {
    if (!trigModal || !String(trigModal.body || '').trim()) {
      message.warning('触发器 SQL 为空');
      return;
    }
    setTrigBusy(true);
    try {
      // 编辑模式：先 DROP 原触发器再执行新定义（mysql/sqlite/pg/mssql 均无安全的在线改触发器）
      const sqlText = trigModal.editName ? trigDropSql(trigModal.editName) + '\n' + trigModal.body : trigModal.body;
      const res = await dbApi(connId, 'query', { sqlText });
      const bad = (res || []).find((r) => r.error);
      if (bad) {
        message.error('执行失败：' + bad.error);
        return;
      }
      message.success(trigModal.editName ? '触发器已更新' : '触发器已创建');
      setTrigModal(null);
      // 等 Modal 关闭动画结束再做刷新/树刷新——紧随的整树重渲染会把 zoom-leave 动画卡死，
      // 残留的 ant-modal-wrap 全屏遮挡后续点击
      setTimeout(() => {
        loadTriggers();
        onChanged();
      }, 350);
    } catch (e) {
      message.error(e.message);
    } finally {
      setTrigBusy(false);
    }
  };
  const trigArgs = (name) => {
    const args = { kind: 'trigger', name, table }; // pg 触发器删除需要 ON 表
    if (isMy) args.db = db;
    if (isPg || isMs) args.schema = schema;
    if (isMs) args.db = db;
    return args;
  };
  // 编辑用 DROP 语句（标识符按方言转义；mssql 走 OBJECT_ID 守卫，兼容低版本）
  const trigDropSql = (name) => {
    const n = String(name || '');
    if (isLite) return `DROP TRIGGER IF EXISTS "${n.replace(/"/g, '""')}";`;
    if (isMy) return `DROP TRIGGER IF EXISTS \`${db}\`.\`${n.replace(/`/g, '``')}\`;`;
    if (isPg) {
      const s = schema ? `"${String(schema).replace(/"/g, '""')}".` : '';
      return `DROP TRIGGER IF EXISTS "${n.replace(/"/g, '""')}" ON ${s}"${String(table).replace(/"/g, '""')}";`;
    }
    const fq = `${db}.${schema || 'dbo'}.${n}`.replace(/'/g, "''");
    return `IF OBJECT_ID(N'${fq}', 'TR') IS NOT NULL DROP TRIGGER [${(schema || 'dbo').replace(/]/g, ']]')}].[${n.replace(/]/g, ']]')}];`;
  };
  const viewTrigger = async (name) => {
    try {
      const text = await dbApi(connId, 'objectDdl', trigArgs(name));
      setTrigDdl({ name, text: String(text || '') });
    } catch (e) {
      message.error(e.message);
    }
  };
  const editTrigger = async (name) => {
    try {
      const text = await dbApi(connId, 'objectDdl', trigArgs(name));
      setTrigModal({ editName: name, name, timing: '', event: '', body: String(text || '') });
    } catch (e) {
      message.error(e.message);
    }
  };
  // pg/mssql 触发器在线启用/禁用（ALTER TABLE … ENABLE/DISABLE TRIGGER / ENABLE|DISABLE TRIGGER … ON …）
  const toggleTriggerRun = (r) => {
    const enable = r.enabled === false;
    dbApi(connId, 'toggleTrigger', { db, schema, table, name: r.name, enable })
      .then(() => {
        message.success(`已${enable ? '启用' : '禁用'}触发器 ${r.name}`);
        setTimeout(() => {
          loadTriggers();
          onChanged();
        }, 300);
      })
      .catch((e) => message.error(e.message));
  };
  const dropTrigger = (name) => {
    Modal.confirm({
      title: `删除触发器「${name}」？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      // 禁用进出动画：确认后的刷新重渲染会把 zoom-leave 动画卡死成全屏遮挡层
      transitionName: '',
      maskTransitionName: '',
      onOk: async () => {
        try {
          await dbApi(connId, 'dropObject', trigArgs(name));
          message.success(`已删除触发器 ${name}`);
          // 同上：延迟到确认框关闭之后再刷新
          setTimeout(() => {
            loadTriggers();
            onChanged();
          }, 350);
        } catch (e) {
          message.error(e.message);
        }
      },
    });
  };

  // ---- 字段页签表格 ----
  const colNames = cols.map((c) => String(c.name || '').trim()).filter(Boolean);
  const columns = [
    {
      title: '',
      dataIndex: 'drag',
      width: 34,
      align: 'center',
      render: (_, r) => (
        <HolderOutlined
          className="drag-handle"
          title="拖动调整列顺序（保存后同步到表结构）"
          onMouseDown={() => setArmed(true)}
          onMouseUp={() => setArmed(false)}
        />
      ),
    },
    {
      title: '字段名',
      dataIndex: 'name',
      width: 170,
      render: (_, r) => <Input size="small" value={r.name} onChange={(e) => upd(r.key, { name: e.target.value })} placeholder="字段名" />,
    },
    {
      title: '类型',
      dataIndex: 'dataType',
      width: 150,
      render: (_, r) => {
        const cur = String(r.dataType || '').trim().toUpperCase();
        return (
          <Select
            size="small"
            style={{ width: '100%' }}
            value={cur || undefined}
            placeholder="类型"
            showSearch
            optionFilterProp="value"
            popupMatchSelectWidth={false}
            options={cur && !TYPES.includes(cur) ? [{ value: cur }, ...TYPE_OPTIONS] : TYPE_OPTIONS}
            onChange={(v) => upd(r.key, { dataType: v })}
          />
        );
      },
    },
    {
      title: '长度',
      dataIndex: 'length',
      width: 80,
      render: (_, r) => <Input size="small" value={r.length} onChange={(e) => upd(r.key, { length: e.target.value })} placeholder="-" />,
    },
    {
      title: '小数位',
      dataIndex: 'scale',
      width: 70,
      render: (_, r) => <Input size="small" value={r.scale} onChange={(e) => upd(r.key, { scale: e.target.value })} placeholder="-" />,
    },
    {
      title: '主键',
      dataIndex: 'pk',
      width: 55,
      render: (_, r) => <Checkbox checked={r.pk} onChange={(e) => upd(r.key, { pk: e.target.checked })} />,
    },
    {
      title: '非空',
      dataIndex: 'nullable',
      width: 55,
      render: (_, r) => <Checkbox checked={!r.nullable} onChange={(e) => upd(r.key, { nullable: !e.target.checked })} />,
    },
    {
      title: '自增',
      dataIndex: 'autoInc',
      width: 55,
      render: (_, r) => <Checkbox checked={r.autoInc} onChange={(e) => upd(r.key, { autoInc: e.target.checked })} />,
    },
    {
      title: '默认值（SQL 表达式）',
      dataIndex: 'defaultValue',
      width: 150,
      render: (_, r) => <Input size="small" value={r.defaultValue} onChange={(e) => upd(r.key, { defaultValue: e.target.value })} placeholder="如 0 / NOW()" />,
    },
    {
      title: '注释',
      dataIndex: 'comment',
      width: 160,
      render: (_, r) => <Input size="small" value={r.comment} onChange={(e) => upd(r.key, { comment: e.target.value })} />,
    },
    {
      title: '原名',
      dataIndex: 'origName',
      width: 90,
      ellipsis: true,
      render: (_, r) => <span style={{ color: '#aaa', fontSize: 11 }}>{r.origName || ''}</span>,
    },
  ];

  // ---- 各对象编辑表格 ----
  const listUpd = (setter) => (key, patch) => setter((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const updIdx = listUpd(setIdxs);
  const updUq = listUpd(setUqs);
  const updFk = listUpd(setFks);
  const updCk = listUpd(setCks);
  const refActions = isMs ? REF_ACTIONS_MSSQL : REF_ACTIONS;
  const refActionOptions = refActions.map((a) => ({ value: a, label: a || 'NO ACTION（默认）' }));

  // 索引类型选项按方言：MySQL BTREE/HASH/FULLTEXT/SPATIAL；PG 访问方法；MSSQL 聚集/非聚集
  const idxTypeOptions = (isMy
    ? ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL']
    : isPg
      ? ['BTREE', 'HASH', 'GIST', 'GIN', 'SPGIST', 'BRIN']
      : ['NONCLUSTERED', 'CLUSTERED']
  ).map((v) => ({ value: v }));

  const idxColumns = [
    { title: '索引名', dataIndex: 'name', width: 170, render: (_, r) => <Input size="small" value={r.name} onChange={(e) => updIdx(r.key, { name: e.target.value })} placeholder="idx_name" /> },
    {
      title: '字段',
      dataIndex: 'columns',
      render: (_, r) => (
        <Select
          mode="multiple"
          size="small"
          style={{ width: '100%' }}
          value={r.columns}
          options={colNames.map((c) => ({ value: c }))}
          onChange={(v) => {
            const oldDirs = r.dirs || [];
            updIdx(r.key, {
              columns: v,
              dirs: v.map((cn) => {
                const i = (r.columns || []).indexOf(cn);
                return i >= 0 ? oldDirs[i] || '' : '';
              }),
            });
          }}
          placeholder="选择列"
        />
      ),
    },
    ...(isLite
      ? []
      : [
          {
            title: '索引类型',
            dataIndex: 'type',
            width: 130,
            render: (_, r) => (
              <Select
                size="small"
                style={{ width: '100%' }}
                allowClear
                value={r.type || undefined}
                options={idxTypeOptions}
                onChange={(v) => updIdx(r.key, { type: v || '' })}
                placeholder={isPg ? 'BTREE' : '默认'}
              />
            ),
          },
        ]),
    {
      title: '唯一',
      dataIndex: 'unique',
      width: 50,
      align: 'center',
      render: (_, r) => <Checkbox checked={!!r.unique} onChange={(e) => updIdx(r.key, { unique: e.target.checked })} />,
    },
    ...(isLite
      ? []
      : [
          {
            title: '注释',
            dataIndex: 'comment',
            width: 150,
            render: (_, r) => <Input size="small" value={r.comment} onChange={(e) => updIdx(r.key, { comment: e.target.value })} placeholder="索引注释" />,
          },
        ]),
    {
      title: '操作',
      width: 60,
      render: (_, r) => (
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setIdxs((prev) => prev.filter((x) => x.key !== r.key))} />
      ),
    },
  ];
  const uqColumns = [
    { title: '唯一键名', dataIndex: 'name', width: 170, render: (_, r) => <Input size="small" value={r.name} onChange={(e) => updUq(r.key, { name: e.target.value })} placeholder="uk_name" /> },
    {
      title: '字段',
      dataIndex: 'columns',
      render: (_, r) => (
        <Select mode="multiple" size="small" style={{ width: '100%' }} value={r.columns} options={colNames.map((c) => ({ value: c }))} onChange={(v) => updUq(r.key, { columns: v })} placeholder="选择列" />
      ),
    },
    ...(isMs
      ? [
          {
            title: '聚集',
            dataIndex: 'clustered',
            width: 50,
            align: 'center',
            render: (_, r) => <Checkbox checked={!!r.clustered} onChange={(e) => updUq(r.key, { clustered: e.target.checked })} />,
          },
        ]
      : []),
    ...(isLite
      ? []
      : [
          {
            title: '注释',
            dataIndex: 'comment',
            width: 150,
            render: (_, r) => <Input size="small" value={r.comment} onChange={(e) => updUq(r.key, { comment: e.target.value })} placeholder="唯一键注释" />,
          },
        ]),
    {
      title: '操作',
      width: 60,
      render: (_, r) => (
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setUqs((prev) => prev.filter((x) => x.key !== r.key))} />
      ),
    },
  ];
  const fkColumns = [
    { title: '名称', dataIndex: 'name', width: 140, render: (_, r) => <Input size="small" value={r.name} onChange={(e) => updFk(r.key, { name: e.target.value })} placeholder="fk_name" /> },
    {
      title: '字段',
      dataIndex: 'columns',
      width: 150,
      render: (_, r) => (
        <Select mode="multiple" size="small" style={{ width: '100%' }} value={r.columns} options={colNames.map((c) => ({ value: c }))} onChange={(v) => updFk(r.key, { columns: v })} placeholder="选择列" />
      ),
    },
    ...(isLite
      ? []
      : [
          {
            title: '被引用的模式',
            dataIndex: 'refSchema',
            width: 120,
            render: (_, r) => (
              <Input size="small" value={r.refSchema} onChange={(e) => updFk(r.key, { refSchema: e.target.value })} placeholder={isMy ? '数据库' : 'schema'} />
            ),
          },
        ]),
    {
      title: '被引用的表(父)',
      dataIndex: 'refTable',
      width: 150,
      render: (_, r) => (
        <Select
          size="small"
          showSearch
          optionFilterProp="value"
          style={{ width: '100%' }}
          value={r.refTable || undefined}
          options={tables.map((t) => ({ value: t }))}
          onChange={(v) => {
            const patch = { refTable: v, refColumns: [] };
            if (!String(r.refSchema || '').trim()) patch.refSchema = isMy ? db : isPg || isMs ? schema : '';
            updFk(r.key, patch);
            ensureRefCols(v, patch.refSchema);
          }}
          placeholder="选择表"
        />
      ),
    },
    {
      title: '被引用的字段',
      dataIndex: 'refColumns',
      width: 150,
      render: (_, r) => (
        <Select
          mode="multiple"
          size="small"
          style={{ width: '100%' }}
          value={r.refColumns}
          options={(refColsRef.current[refColKeyOf(r)] || []).map((c) => ({ value: c }))}
          onChange={(v) => updFk(r.key, { refColumns: v })}
          placeholder="选择列"
          notFoundContent={r.refTable ? '该表无列或读取失败' : '先选择引用表'}
        />
      ),
    },
    { title: '删除时', dataIndex: 'onDelete', width: 125, render: (_, r) => <Select size="small" style={{ width: '100%' }} value={r.onDelete || ''} options={refActionOptions} onChange={(v) => updFk(r.key, { onDelete: v })} /> },
    { title: '更新时', dataIndex: 'onUpdate', width: 125, render: (_, r) => <Select size="small" style={{ width: '100%' }} value={r.onUpdate || ''} options={refActionOptions} onChange={(v) => updFk(r.key, { onUpdate: v })} /> },
    ...(isPg || isMs
      ? [
          {
            title: '注释',
            dataIndex: 'comment',
            width: 140,
            render: (_, r) => <Input size="small" value={r.comment} onChange={(e) => updFk(r.key, { comment: e.target.value })} placeholder="外键注释" />,
          },
        ]
      : []),
    {
      title: '操作',
      width: 60,
      render: (_, r) => (
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setFks((prev) => prev.filter((x) => x.key !== r.key))} />
      ),
    },
  ];
  const ckColumns = [
    { title: '名称', dataIndex: 'name', width: 180, render: (_, r) => <Input size="small" value={r.name} onChange={(e) => updCk(r.key, { name: e.target.value })} placeholder="ck_name" /> },
    { title: '表达式', dataIndex: 'expr', render: (_, r) => <Input size="small" value={r.expr} onChange={(e) => updCk(r.key, { expr: e.target.value })} placeholder="如 salary >= 0" /> },
    ...(isLite || isMy
      ? []
      : [
          {
            title: '注释',
            dataIndex: 'comment',
            width: 220,
            render: (_, r) => <Input size="small" value={r.comment} onChange={(e) => updCk(r.key, { comment: e.target.value })} placeholder="注释" />,
          },
        ]),
    ...(isMs
      ? [
          {
            title: '启用',
            dataIndex: 'enabled',
            width: 84,
            render: (_, r) => (
              <Select
                size="small"
                style={{ width: 64 }}
                value={r.enabled !== false ? '是' : '否'}
                options={[{ value: '是' }, { value: '否' }]}
                onChange={(v) => updCk(r.key, { enabled: v === '是' })}
              />
            ),
          },
          {
            title: '不适用于复制',
            dataIndex: 'notForReplication',
            width: 100,
            align: 'center',
            render: (_, r) => <Checkbox checked={!!r.notForReplication} onChange={(e) => updCk(r.key, { notForReplication: e.target.checked })} />,
          },
        ]
      : []),
    {
      title: '操作',
      width: 70,
      render: (_, r) => (
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setCks((prev) => prev.filter((x) => x.key !== r.key))} />
      ),
    },
  ];
  // 触发器时机/事件：驱动已返回则直接用（pg/mssql/mysql），否则从 DDL 文本解析（sqlite）
  const trigTE = (r) => {
    if (r.timing || r.event) return { timing: String(r.timing || ''), event: String(r.event || '') };
    const m = String(r.sql || '').match(/\b(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)\b/i);
    return m ? { timing: m[1].toUpperCase().replace(/\s+/g, ' '), event: m[2].toUpperCase() } : { timing: '', event: '' };
  };
  const trigColumns = [
    { title: '触发器', dataIndex: 'name', width: 170, render: (_, r) => <code style={{ fontSize: 12 }}>{r.name}</code> },
    { title: '时机', width: 88, render: (_, r) => <span style={{ color: '#666' }}>{trigTE(r).timing || '-'}</span> },
    { title: '事件', width: 78, render: (_, r) => <span style={{ color: '#666' }}>{trigTE(r).event || '-'}</span> },
    {
      title: '定义',
      dataIndex: 'sql',
      render: (_, r) => {
        const s = r.sql || [r.timing, r.event].filter(Boolean).join(' ') || '';
        return <span style={{ color: '#888', fontSize: 12 }}>{String(s).replace(/\s+/g, ' ').slice(0, 100)}</span>;
      },
    },
    ...(isPg || isMs
      ? [
          {
            title: '状态',
            width: 128,
            render: (_, r) => (
              <Space size={4}>
                {r.enabled === false ? (
                  <>
                    <span style={{ color: '#d46b08', fontSize: 12 }}>已禁用</span>
                    <Button size="small" type="link" style={{ padding: 0, height: 20 }} onClick={() => toggleTriggerRun(r)}>
                      启用
                    </Button>
                  </>
                ) : (
                  <>
                    <span style={{ color: '#389e0d', fontSize: 12 }}>已启用</span>
                    <Button size="small" type="link" style={{ padding: 0, height: 20 }} onClick={() => toggleTriggerRun(r)}>
                      禁用
                    </Button>
                  </>
                )}
              </Space>
            ),
          },
        ]
      : []),
    {
      title: '操作',
      width: 110,
      render: (_, r) => (
        <Space size={0}>
          <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => viewTrigger(r.name)} title="查看定义" />
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => editTrigger(r.name)} title="编辑（先删后建）" />
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => dropTrigger(r.name)} title="删除" />
        </Space>
      ),
    },
  ];

  const listTabsNote = '（随「保存」一并执行）';
  const unsupportedNote = (
    <div style={{ padding: '24px 12px', color: '#999' }}>
      {DT === 'oracle' ? 'Oracle 连接暂不支持图形化配置该项。' : '当前数据库类型暂不支持图形化配置该项。'}
    </div>
  );

  const designItems = [
    {
      key: 'fields',
      label: '字段',
      children: (
        <div className="grid-area" ref={gridRef}>
          <Table
            className="design-table"
            size="small"
            columns={columns}
            dataSource={cols}
            rowKey="key"
            pagination={false}
            scroll={{ x: 'max-content', y: gridH }}
            rowSelection={{ selectedRowKeys: sel, onChange: setSel }}
            onRow={onRow}
            rowClassName={(r) => {
              const base = over && over.key === r.key ? (over.pos === 'above' ? 'drop-above' : 'drop-below') : dragging === r.key ? 'row-dragging' : '';
              return focusHit && focusHit.tab === 'fields' && r.key === focusHit.key ? `${base} row-focus`.trim() : base;
            }}
          />
        </div>
      ),
    },
    {
      key: 'idx',
      label: '索引',
      children: !objSupported ? (
        unsupportedNote
      ) : (
        <div className="obj-tab">
          <div className="obj-toolbar">
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={addIdx}
            >
              添加索引
            </Button>
            <span className="ctx">
              {isLite
                ? 'SQLite：按差异 CREATE/DROP INDEX（支持表达式键/部分索引 WHERE/降序）'
                : isMs
                  ? '点行可在下方设置各字段升序/降序与键顺序；类型=聚集/非聚集；支持筛选索引 WHERE'
                  : isMy
                    ? '点行可在下方设置各字段升序/降序；类型含 FULLTEXT/SPATIAL'
                    : '点行可在下方设置各字段升序/降序、表达式键与部分索引 WHERE'}
              {listTabsNote}
            </span>
          </div>
          <Table
            size="small"
            className="obj-table"
            columns={idxColumns}
            dataSource={idxs}
            rowKey="key"
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: '暂无索引' }}
            onRow={(r) => ({ onClick: () => setIdxSelKey(r.key) })}
            rowClassName={(r) => (focusHit && focusHit.tab === 'idx' && r.key === focusHit.key ? 'row-focus' : '')}
          />
          {(() => {
            const row = idxs.find((x) => x.key === idxSelKey);
            if (!row) return <div className="bar-panel hint">点击索引行，可在下方设置各字段的升序/降序、表达式键与键顺序</div>;
            if (!(row.columns || []).length) return <div className="bar-panel hint">「{row.name || '未命名'}」未选择字段</div>;
            const setKeyAt = (i, v) =>
              updIdx(row.key, { columns: (row.columns || []).map((c, j) => (j === i ? v : c)) });
            const moveKey = (i, delta) => {
              const cols = [...(row.columns || [])];
              const dirs = [...(row.dirs || [])];
              const j = i + delta;
              if (j < 0 || j >= cols.length) return;
              [cols[i], cols[j]] = [cols[j], cols[i]];
              [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
              updIdx(row.key, { columns: cols, dirs });
            };
            const delKey = (i) => {
              updIdx(row.key, {
                columns: (row.columns || []).filter((_, j) => j !== i),
                dirs: (row.dirs || []).filter((_, j) => j !== i),
              });
            };
            const exprAllowed = isPg || isLite;
            const whereAllowed = isPg || isLite || isMs;
            return (
              <>
                <div className="bar-panel" data-dh-idx="keys-panel">
                  <span className="bar-title">{`「${row.name || '未命名'}」栏位`}</span>
                  {exprAllowed && (
                    <Button
                      size="small"
                      data-dh-idx="addexpr"
                      onClick={() => updIdx(row.key, { columns: [...(row.columns || []), ''], dirs: [...(row.dirs || []), ''] })}
                    >
                      + 表达式键
                    </Button>
                  )}
                  {(row.columns || []).map((cn, i) => {
                    const isExpr = !colNames.includes(cn);
                    return (
                      <span className="dir-item" key={cn + '_' + i}>
                        {isExpr ? (
                          <Input
                            size="small"
                            style={{ width: 190 }}
                            data-dh-idx="expr"
                            value={cn}
                            placeholder="表达式，如 LOWER(nm)"
                            onChange={(e) => setKeyAt(i, e.target.value)}
                          />
                        ) : (
                          <code>{cn}</code>
                        )}
                        <Select
                          size="small"
                          style={{ width: 118 }}
                          value={row.dirs && row.dirs[i] === 'DESC' ? 'DESC' : ''}
                          options={[{ value: '', label: '升序（默认）' }, { value: 'DESC', label: '降序' }]}
                          onChange={(v) =>
                            updIdx(row.key, {
                              dirs: (row.columns || []).map((_, j) => (j === i ? v : (row.dirs || [])[j] || '')),
                            })
                          }
                        />
                        <Button size="small" type="text" data-dh-idx="moveup" icon={<UpOutlined />} disabled={i === 0} title="上移" onClick={() => moveKey(i, -1)} />
                        <Button
                          size="small"
                          type="text"
                          data-dh-idx="movedown"
                          icon={<DownOutlined />}
                          disabled={i === (row.columns || []).length - 1}
                          title="下移"
                          onClick={() => moveKey(i, 1)}
                        />
                        <Button size="small" type="text" danger data-dh-idx="delkey" icon={<CloseOutlined />} title="移除该键" onClick={() => delKey(i)} />
                      </span>
                    );
                  })}
                </div>
                {whereAllowed && (
                  <div className="bar-panel" data-dh-idx="where-panel">
                    <span className="bar-title">部分索引 WHERE</span>
                    <Input
                      size="small"
                      style={{ width: 340 }}
                      data-dh-idx="where"
                      value={row.where || ''}
                      placeholder="如 qty > 0（仅索引满足条件的行）"
                      onChange={(e) => updIdx(row.key, { where: e.target.value })}
                    />
                    <span className="ctx">
                      {isLite ? 'SQLite 部分索引' : isPg ? 'PostgreSQL 部分索引' : 'SQL Server 筛选索引（filtered index）'}
                    </span>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ),
    },
    {
      key: 'fk',
      label: '外键',
      children: !objSupported ? (
        unsupportedNote
      ) : (
        <div className="obj-tab">
          <div className="obj-toolbar">
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={addFk}
            >
              添加外键
            </Button>
            <span className="ctx">
              {isLite ? 'SQLite：外键变更通过重建表完成（数据保留）' : isMs ? '点行可在下方设置 启用 / 不适用于复制' : '被引用模式/表按需跨库、跨 schema'}
              {listTabsNote}
            </span>
          </div>
          <Table
            size="small"
            className="obj-table"
            columns={fkColumns}
            dataSource={fks}
            rowKey="key"
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: '暂无外键' }}
            onRow={(r) => ({ onClick: () => setFkSelKey(r.key) })}
            rowClassName={(r) => (focusHit && focusHit.tab === 'fk' && r.key === focusHit.key ? 'row-focus' : '')}
          />
          {isMs ? (
            (() => {
              const row = fks.find((x) => x.key === fkSelKey);
              if (!row) return <div className="bar-panel hint">点击外键行，可在下方设置 启用 / 不适用于复制</div>;
              return (
                <div className="bar-panel">
                  <span className="bar-title">{`「${row.name || '未命名'}」属性`}</span>
                  <Checkbox checked={row.enabled !== false} onChange={(e) => updFk(row.key, { enabled: e.target.checked })}>
                    启用
                  </Checkbox>
                  <Checkbox checked={!!row.notForReplication} onChange={(e) => updFk(row.key, { notForReplication: e.target.checked })}>
                    不适用于复制
                  </Checkbox>
                  <span className="ctx">禁用状态切换生成 NOCHECK/CHECK（不重建约束）</span>
                </div>
              );
            })()
          ) : null}
        </div>
      ),
    },
    {
      key: 'uq',
      label: '唯一键',
      children: !objSupported ? (
        unsupportedNote
      ) : (
        <div className="obj-tab">
          <div className="obj-toolbar">
            <Button size="small" icon={<PlusOutlined />} onClick={addUq}>
              添加唯一键
            </Button>
            <span className="ctx">{isMy ? 'MySQL：以唯一索引实现（ADD UNIQUE KEY，可带注释）' : isLite ? 'SQLite：以 UNIQUE INDEX 实现' : isMs ? '聚集唯一键会与聚集主键冲突，同表仅一个聚集' : '以唯一约束实现（可配注释）'}{listTabsNote}</span>
          </div>
          <Table size="small" className="obj-table" columns={uqColumns} dataSource={uqs} rowKey="key" pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: '暂无唯一键' }} rowClassName={(r) => (focusHit && focusHit.tab === 'uq' && r.key === focusHit.key ? 'row-focus' : '')} />
        </div>
      ),
    },
    {
      key: 'ck',
      label: '检查',
      children: !objSupported ? (
        unsupportedNote
      ) : (
        <div className="obj-tab">
          <div className="obj-toolbar">
            <Button size="small" icon={<PlusOutlined />} onClick={addCk}>
              添加检查约束
            </Button>
            <span className="ctx">{isLite ? 'SQLite：CHECK 变更通过重建表完成' : '表达式按原样写入 CHECK (…)'}{listTabsNote}</span>
          </div>
          <Table size="small" className="obj-table" columns={ckColumns} dataSource={cks} rowKey="key" pagination={false} locale={{ emptyText: '暂无检查约束' }} rowClassName={(r) => (focusHit && focusHit.tab === 'ck' && r.key === focusHit.key ? 'row-focus' : '')} />
        </div>
      ),
    },
    {
      key: 'trig',
      label: '触发器',
      children: !objSupported ? (
        unsupportedNote
      ) : (
        <div className="obj-tab">
          <div className="obj-toolbar">
            <Button size="small" icon={<ReloadOutlined />} onClick={loadTriggers}>
              刷新
            </Button>
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() =>
                setTrigModal({ name: 'trig_' + String(table || 't') + '_1', timing: 'AFTER', event: 'INSERT', body: '' })
              }
            >
              新建触发器
            </Button>
            <span className="ctx">触发器立即执行新建/编辑/删除{isPg || isMs ? '；pg/mssql 支持在线启用/禁用' : ''}，不随「保存」</span>
          </div>
          <Table size="small" className="obj-table" columns={trigColumns} dataSource={trigs} rowKey="name" pagination={false} locale={{ emptyText: '暂无触发器' }} rowClassName={(r) => (focusHit && focusHit.tab === 'trig' && r.name === focusHit.key ? 'row-focus' : '')} />
        </div>
      ),
    },
    {
      key: 'opt',
      label: '选项',
      children: !objSupported ? (
        unsupportedNote
      ) : isMy ? (
        <div className="obj-tab" style={{ maxWidth: 480 }}>
          <div className="opt-row">
            <span>存储引擎：</span>
            <Select
              size="small"
              style={{ width: 180 }}
              value={info.options.engine || undefined}
              allowClear
              options={['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV'].map((v) => ({ value: v }))}
              onChange={(v) => setInfo((p) => ({ ...p, options: { ...p.options, engine: v || '' } }))}
              placeholder="默认"
            />
          </div>
          <div className="opt-row">
            <span>排序规则：</span>
            <Input size="small" style={{ width: 220 }} value={info.options.collation || ''} onChange={(e) => setInfo((p) => ({ ...p, options: { ...p.options, collation: e.target.value } }))} placeholder="如 utf8mb4_general_ci" />
          </div>
          <div className="opt-row">
            <span>AUTO_INCREMENT：</span>
            <Input size="small" style={{ width: 140 }} value={info.options.autoIncrement || ''} onChange={(e) => setInfo((p) => ({ ...p, options: { ...p.options, autoIncrement: e.target.value } }))} placeholder="下一自增值" />
          </div>
          <div className="ctx" style={{ marginTop: 8 }}>仅提交发生变化的选项{listTabsNote}</div>
        </div>
      ) : (
        <div style={{ padding: '24px 12px', color: '#999' }}>{DT === 'pg' ? 'PostgreSQL 表级通用选项请使用「存储」页（fillfactor 等）。' : '当前数据库暂无可配置的表选项。'}</div>
      ),
    },
    {
      key: 'store',
      label: '存储',
      children: !objSupported ? (
        unsupportedNote
      ) : isPg ? (
        <div className="obj-tab" style={{ maxWidth: 480 }}>
          <div className="opt-row">
            <span>fillfactor：</span>
            <Input
              size="small"
              style={{ width: 140 }}
              value={info.options.fillfactor || ''}
              onChange={(e) => setInfo((p) => ({ ...p, options: { ...p.options, fillfactor: e.target.value } }))}
              placeholder="如 90（10-100）"
            />
          </div>
          <div className="opt-row">
            <span>autovacuum_enabled：</span>
            <Select
              size="small"
              style={{ width: 140 }}
              value={info.options.autovacuum_enabled || undefined}
              allowClear
              options={[{ value: 'on' }, { value: 'off' }]}
              onChange={(v) => setInfo((p) => ({ ...p, options: { ...p.options, autovacuum_enabled: v || '' } }))}
              placeholder="默认"
            />
          </div>
          <div className="ctx" style={{ marginTop: 8 }}>保存时生成 ALTER TABLE … SET (…)，仅提交变化项</div>
        </div>
      ) : isMy ? (
        <div className="obj-tab" style={{ maxWidth: 520 }}>
          <div className="opt-row">
            <span>ROW_FORMAT：</span>
            <Select
              size="small"
              style={{ width: 160 }}
              value={info.options.rowFormat || undefined}
              allowClear
              options={['COMPACT', 'DYNAMIC', 'COMPRESSED', 'REDUNDANT'].map((v) => ({ value: v }))}
              onChange={(v) => setInfo((p) => ({ ...p, options: { ...p.options, rowFormat: v || '' } }))}
              placeholder="默认"
            />
          </div>
          <div className="opt-row">
            <span>KEY_BLOCK_SIZE：</span>
            <Input size="small" style={{ width: 140 }} value={info.options.keyBlockSize || ''} onChange={(e) => setInfo((p) => ({ ...p, options: { ...p.options, keyBlockSize: e.target.value } }))} placeholder="如 8" />
          </div>
        </div>
      ) : (
        <div style={{ padding: '24px 12px', color: '#999' }}>当前数据库暂无存储参数配置。</div>
      ),
    },
    {
      key: 'cmt',
      label: '注释',
      children: !objSupported || isLite ? (
        <div style={{ padding: '24px 12px', color: '#999' }}>SQLite 不支持表注释。</div>
      ) : (
        <div className="obj-tab" style={{ maxWidth: 640 }}>
          <Input.TextArea
            rows={4}
            value={info.comment}
            onChange={(e) => setInfo((p) => ({ ...p, comment: e.target.value }))}
            placeholder="表注释"
            maxLength={2000}
            showCount
          />
          <div className="ctx" style={{ marginTop: 8 }}>
            {isMs ? 'SQL Server：保存为扩展属性 MS_Description' : '保存时生成注释 DDL'}
          </div>
        </div>
      ),
    },
    {
      key: 'sql',
      label: 'SQL 预览',
      children: isNew ? (
        <div style={{ padding: '24px 12px', color: '#999' }}>新表请配置好各页签后点工具栏「创建表」，将执行 CREATE TABLE 及索引/约束语句。</div>
      ) : (
        <div className="obj-tab sql-tab">
          <div className="obj-toolbar">
            <Button size="small" icon={<ReloadOutlined />} onClick={refreshPreview}>
              刷新预览
            </Button>
            <span className="ctx">按当前各页签内容与数据库现状的差异生成（只读预览；工具栏「保存」直接执行变更）</span>
          </div>
          {fkRefs ? (
            <div className="dh-fkwarn" data-dh-fkwarn="1">
              {fkRefs.length
                ? '列序变更将重建本表（DROP+重建+改名）。他表外键引用了本表，DROP 可能失败或需先处理引用：' +
                  fkRefs.map((x) => (x.schema ? x.schema + '.' : '') + x.table + '（' + x.name + '）').join('、')
                : '列序变更将重建本表（DROP+重建+改名）：当前没有他表外键引用本表，索引/约束将自动复原。'}
            </div>
          ) : null}
          {previewErr ? (
            <div className="msg err" style={{ margin: '0 12px' }}>生成失败：{previewErr}</div>
          ) : (
            <div className="sql-preview" style={{ maxHeight: gridH + 100 }}>
              {(sqlPreview || []).length ? (sqlPreview || []).join('\n') : '-- 没有检测到变更'}
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <Space size={4}>
          <span>表名：</span>
          <Input size="small" style={{ width: 180 }} value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="table_name" disabled={!isNew} />
        </Space>
        <Button size="small" icon={<PlusOutlined />} onClick={() => { addCol(); setActiveTab('fields'); }}>
          添加字段
        </Button>
        <Button size="small" icon={<MinusOutlined />} disabled={!sel.length} onClick={delCols}>
          删除字段{sel.length ? `(${sel.length})` : ''}
        </Button>
        <span className="toolbar-spacer" />
        <Button size="small" type="primary" icon={<SaveOutlined />} loading={applying} onClick={save}>
          {isNew ? '创建表' : '保存'}
        </Button>
        <span className="ctx">
          {connName} · {isNew ? '新建表' : table}（字段/索引/外键/唯一键/检查/选项/注释随「保存」执行；拖动手柄调列序：MySQL MODIFY…AFTER，SQLite/PostgreSQL/MSSQL 重建表，数据保留）
        </span>
      </div>
      <Tabs
        size="small"
        className="design-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={designItems}
        tabBarStyle={{ margin: 0, padding: '0 8px' }}
      />
      <Modal
        open={!!trigModal}
        title={trigModal && trigModal.editName ? `编辑触发器：${trigModal.editName}` : '新建触发器'}
        width={680}
        okText="执行"
        cancelText="取消"
        confirmLoading={trigBusy}
        onOk={runTriggerSql}
        onCancel={() => setTrigModal(null)}
      >
        {!(trigModal && trigModal.editName) && (
          <Space size={8} style={{ marginBottom: 8 }} wrap>
            <span>名称：</span>
            <Input size="small" style={{ width: 200 }} value={trigModal ? trigModal.name : ''} onChange={(e) => setTrigModal((p) => (p ? { ...p, name: e.target.value } : p))} />
            <span>时机：</span>
            <Select size="small" style={{ width: 120 }} value={trigModal ? trigModal.timing : 'AFTER'} options={trigTimings.map((v) => ({ value: v }))} onChange={(v) => setTrigModal((p) => (p ? { ...p, timing: v } : p))} />
            <span>事件：</span>
            <Select size="small" style={{ width: 110 }} value={trigModal ? trigModal.event : 'INSERT'} options={['INSERT', 'UPDATE', 'DELETE'].map((v) => ({ value: v }))} onChange={(v) => setTrigModal((p) => (p ? { ...p, event: v } : p))} />
            <Button
              size="small"
              onClick={() => setTrigModal((p) => (p ? { ...p, body: trigTemplate(p.name, p.timing, p.event) } : p))}
            >
              生成模板
            </Button>
          </Space>
        )}
        <Input.TextArea
          rows={12}
          style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
          value={trigModal ? trigModal.body || '' : ''}
          onChange={(e) => setTrigModal((p) => (p ? { ...p, body: e.target.value } : p))}
          placeholder="点「生成模板」后按需修改，或直接粘贴 CREATE TRIGGER 语句"
        />
        <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
          {trigModal && trigModal.editName
            ? '执行时将先 DROP 原触发器，再执行以下语句（可含多条，按分号/DELIMITER 切分）。'
            : '立即在数据库上执行（可含多条语句，按分号/DELIMITER 切分）。'}
        </div>
      </Modal>
      <Modal open={!!trigDdl} title={trigDdl ? `触发器：${trigDdl.name}` : ''} footer={null} width={680} onCancel={() => setTrigDdl(null)}>
        <div className="sql-preview">{trigDdl ? trigDdl.text : ''}</div>
      </Modal>
    </div>
  );
}
