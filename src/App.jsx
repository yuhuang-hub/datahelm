import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigProvider, theme as antdTheme, Tabs, Modal, message, Button, Input } from 'antd';
import {
  ApiOutlined,
  ApartmentOutlined,
  ArrowRightOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  DatabaseOutlined,
  DiffOutlined,
  EditOutlined,
  EyeOutlined,
  FileAddOutlined,
  HistoryOutlined,
  HddOutlined,
  MinusCircleOutlined,
  PushpinFilled,
  PushpinOutlined,
  SettingOutlined,
  TableOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import Sidebar from './components/Sidebar';
import { DhCrashProbe } from './components/ErrorBoundary';
import AppIcon from './components/AppIcon';
import ConnectionModal from './components/ConnectionModal';
import InputContextMenu from './components/InputContextMenu';
import FloatMenu from './components/FloatMenu';
import SavedQueriesModal from './components/SavedQueriesModal';
import CompletionSettingsModal from './components/CompletionSettingsModal';
import ImportWizard from './components/ImportWizard';
import DataTab from './components/tabs/DataTab';
import DesignTab from './components/tabs/DesignTab';
import QueryTab from './components/tabs/QueryTab';
import DdlTab from './components/tabs/DdlTab';
import RedisTab from './components/tabs/RedisTab';
import ObjEditTab from './components/tabs/ObjEditTab';
import ViewDesignTab from './components/tabs/ViewDesignTab';
import ErTab from './components/tabs/ErTab';
import UsersTab from './components/tabs/UsersTab';
import BackupsTab from './components/tabs/BackupsTab';
import ObjListTab from './components/tabs/ObjListTab';
import SyncTab from './components/tabs/SyncTab';
import DataSyncTab from './components/tabs/DataSyncTab';
import RestoreTab from './components/tabs/RestoreTab';
import { connApi, dbOpen, dbClose, appApi } from './api';

let tabSeq = 0;

export default function App() {
  const [conns, setConns] = useState([]);
  const [sessions, setSessions] = useState({}); // connId -> {type, serverInfo}
  const [tabs, setTabs] = useState([]);
  const [activeKey, setActiveKey] = useState('');
  const [dark, setDark] = useState(false);
  const [connModal, setConnModal] = useState(null);
  const [savedQueriesOpen, setSavedQueriesOpen] = useState(false);
  const [importState, setImportState] = useState(null); // 导入向导上下文 {connId, db, schema, mode?, table?}
  const [treeSel, setTreeSel] = useState(null); // 树选择上下文（工具栏目标：选中库/表即获得上下文）
  const [status, setStatus] = useState('就绪');
  const [sidebarVer, setSidebarVer] = useState(0); // 递增触发对象树刷新
  const [acSetOpen, setAcSetOpen] = useState(false); // 补全设置面板（状态栏齿轮 / 编辑器右键）

  const refreshConns = useCallback(async () => setConns(await connApi.list()), []);
  // 初始就绪上报：连接列表首次加载完成后向主进程发 dh-ui-ready（主窗【显示】要等这个信号 +
  // Splash 最短展示时间，避免先露出空窗/白屏再等连接出现）。__dhReadyConns 供启动时序测试断言。
  useEffect(() => {
    let alive = true;
    (async () => {
      let n = 0;
      try {
        const list = await connApi.list();
        if (!alive) return;
        n = list.length;
        setConns(list);
      } catch {}
      if (!alive) return;
      try { window.__dhReadyConns = n; } catch {}
      console.log(`DH-CONNS-READY n=${n}`);
      setTimeout(() => { try { if (appApi && appApi.uiReady) appApi.uiReady(); } catch {} }, 30);
    })();
    return () => { alive = false; };
  }, []);

  const findConn = useCallback((id) => conns.find((c) => c.id === id), [conns]);

  const connect = useCallback(async (conn) => {
    try {
      const info = await dbOpen(conn.id);
      setSessions((prev) => ({ ...prev, [conn.id]: info }));
      setStatus(`已连接 ${conn.name}（${info.serverInfo}）`);
    } catch (e) {
      message.error(`连接失败：${e.message}`);
    }
  }, []);

  const disconnect = useCallback((conn) => {
    dbClose(conn.id);
    setSessions((prev) => {
      const n = { ...prev };
      delete n[conn.id];
      return n;
    });
    setTabs((prev) => prev.filter((t) => t.connId !== conn.id));
    setSidebarVer((v) => v + 1);
  }, []);

  const openTab = useCallback((tab) => {
    if (!tab.key) {
      tabSeq += 1;
      tab.key = `${tab.kind}:${tabSeq}`;
    }
    setTabs((prev) => (prev.find((t) => t.key === tab.key) ? prev.map((t) => (t.key === tab.key ? tab : t)) : [...prev, tab]));
    setActiveKey(tab.key);
  }, []);

  // 恢复关闭的标签页：关闭时入栈（LIFO，上限 20）；查询页代码经 codeSyncRef 免渲染同步随行
  const [closedTabs, setClosedTabs] = useState([]);
  const closedRef = useRef(closedTabs);
  closedRef.current = closedTabs;
  const codeSyncRef = useRef({}); // key -> 查询页当前代码（写 ref 不触发渲染）
  const pushClosed = useCallback((recs) => {
    if (!recs.length) return;
    setClosedTabs((prev) => prev.concat(recs).slice(-20));
  }, []);
  const reopenClosed = useCallback(() => {
    const prev = closedRef.current;
    if (!prev.length) return;
    const rec = prev[prev.length - 1];
    setClosedTabs((p) => p.slice(0, -1));
    // 剥离关闭时的脏标记：面板重挂后由组件自行重算（恢复代码 vs 保存基线）；恢复页追加到末尾并激活
    openTab(Object.assign({}, rec, { dirty: false, restoreCode: rec.savedCode }));
  }, [openTab]);
  // Ctrl+Shift+T：与浏览器一致的恢复快捷键
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        reopenClosed();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [reopenClosed]);

  const doCloseTab = useCallback((key) => {
    const prev = tabsRef.current;
    const idx = prev.findIndex((t) => t.key === key);
    if (idx < 0) return;
    // 关闭入栈：带上查询页最新代码（codeSyncRef 免渲染通道），供「恢复关闭的标签页」回灌
    const rec = prev[idx];
    const code = codeSyncRef.current[key];
    pushClosed([code != null ? Object.assign({}, rec, { savedCode: code }) : rec]);
    const next = prev.filter((t) => t.key !== key);
    setTabs(next);
    // 关掉的是活动标签时激活相邻标签：Tabs 受控模式下 activeKey 悬空会让所有面板失活
    setActiveKey((ak) => {
      if (ak !== key) return ak;
      const nb = next[Math.min(idx, next.length - 1)];
      return nb ? nb.key : '';
    });
  }, []);

  // 关标签总是读最新 dirty（子组件“保存后先清脏再 onClose”时，正在执行的闭包里是旧 tabs）
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const closeTab = useCallback(
    (key) => {
      const t = tabsRef.current.find((x) => x.key === key);
      if (t && t.dirty) {
        Modal.confirm({
          title: `「${t.title}」有未保存的修改`,
          content: '关闭后将丢失未保存的更改。',
          okText: '放弃并关闭',
          okType: 'danger',
          cancelText: '取消',
          // 禁用进出动画：关闭确认后紧跟整树重渲染，会把 zoom-leave 动画卡死成全屏遮挡层
          transitionName: '',
          maskTransitionName: '',
          onOk: () => doCloseTab(key),
        });
        return;
      }
      doCloseTab(key);
    },
    [doCloseTab]
  );

  const setTabDirty = useCallback((key, dirty) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? (t.dirty === !!dirty ? t : { ...t, dirty: !!dirty }) : t)));
  }, []);

  // 标签页右键菜单：关闭 / 关闭其他 / 关闭右侧 / 关闭全部
  const [tabCtx, setTabCtx] = useState(null); // {x, y, key} 右键命中的标签（data-tab-key）
  useEffect(() => {
    if (!tabCtx) return;
    const onDown = (e) => {
      if (!e.target.closest || !e.target.closest('.ctx-menu')) setTabCtx(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setTabCtx(null);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [tabCtx]);

  // 批量关标签：一次过滤掉目标键；活动标签被关时激活最近的存活标签；全部入恢复栈
  const doCloseMany = useCallback((keys) => {
    const prev = tabsRef.current;
    if (!prev.length || !keys.length) return;
    const set = new Set(keys);
    const firstIdx = prev.findIndex((t) => set.has(t.key));
    if (firstIdx < 0) return;
    const keep = prev.filter((t) => !set.has(t.key));
    pushClosed(prev.filter((t) => set.has(t.key)).map((t) => (codeSyncRef.current[t.key] != null ? Object.assign({}, t, { savedCode: codeSyncRef.current[t.key] }) : t)));
    setTabs(keep);
    setActiveKey((ak) => {
      if (!set.has(ak)) return ak;
      const nb = keep[Math.min(firstIdx, keep.length - 1)];
      return nb ? nb.key : '';
    });
  }, []);

  // 批量关闭的脏检查：涉及未保存标签时统一确认一次（与单个关闭一致）
  const closeMany = useCallback(
    (keys, label) => {
      const dirty = tabsRef.current.filter((t) => keys.includes(t.key) && t.dirty);
      if (!dirty.length) {
        doCloseMany(keys);
        return;
      }
      Modal.confirm({
        title: `${label}：${keys.length} 个标签中有 ${dirty.length} 个未保存`,
        content: '关闭后将丢失这些标签未保存的更改。',
        okText: '放弃并关闭',
        okType: 'danger',
        cancelText: '取消',
        transitionName: '',
        maskTransitionName: '',
        onOk: () => doCloseMany(keys),
      });
    },
    [doCloseMany]
  );

  // 固定/取消固定标签：固定页签置顶（固定组内保持原相对顺序），激活键不变
  const togglePin = useCallback((key) => {
    setTabs((prev) => {
      const hit = prev.find((t) => t.key === key);
      if (!hit) return prev;
      const next = prev.map((t) => (t.key === key ? { ...t, pinned: !t.pinned } : t));
      return [...next.filter((t) => t.pinned), ...next.filter((t) => !t.pinned)];
    });
  }, []);

  // 重命名标签：仅改页签显示名（连接/库/表等上下文字段不变），脏标记与固定态保留
  const [rename, setRename] = useState(null); // { key, value }
  const applyRename = useCallback(() => {
    if (!rename) return;
    const v = (rename.value || '').trim();
    if (!v) {
      message.warning('标签名不能为空'); // 空名不关闭弹窗
      return;
    }
    setTabs((prev) => prev.map((t) => (t.key === rename.key ? { ...t, title: v } : t)));
    setRename(null);
  }, [rename]);

  // 拖拽排序：拖动页签投放到另一页签上即换位；固定组是稳定前缀——非固定不可插入固定组，固定不可拖出到非固定区
  const dragTabRef = useRef(null);
  const moveTab = useCallback((srcKey, dstKey) => {
    if (!srcKey || srcKey === dstKey) return;
    setTabs((prev) => {
      const si = prev.findIndex((t) => t.key === srcKey);
      const di = prev.findIndex((t) => t.key === dstKey);
      if (si < 0 || di < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(si, 1);
      let ti = di > si ? di - 1 : di; // 去掉源后的目标下标
      const pinEnd = next.filter((t) => t.pinned).length; // 固定组长度（去除源后）
      ti = moved.pinned ? Math.max(0, Math.min(pinEnd - 1, ti)) : Math.max(pinEnd, Math.min(next.length, ti));
      next.splice(ti, 0, moved);
      return next;
    });
  }, []);

  const tabCtxItems = () => {
    const list = tabsRef.current;
    const idx = list.findIndex((t) => t.key === tabCtx.key);
    if (idx < 0) return [];
    const me = list[idx];
    // 批量关闭只收非固定标签：固定页签受保护（取消固定后才能关）
    const others = list.filter((t) => t.key !== tabCtx.key && !t.pinned);
    const rightOpen = list.slice(idx + 1).filter((t) => !t.pinned);
    const allOpen = list.filter((t) => !t.pinned);
    return [
      {
        key: 'pin',
        label: me.pinned ? '取消固定' : '固定标签页',
        icon: me.pinned ? <PushpinFilled /> : <PushpinOutlined />,
        onClick: () => togglePin(tabCtx.key),
      },
      { key: 'rename', label: '重命名', icon: <EditOutlined />, onClick: () => setRename({ key: tabCtx.key, value: me.title }) },
      { key: 'reopen', label: '恢复关闭的标签页', icon: <HistoryOutlined />, disabled: !closedTabs.length, onClick: () => reopenClosed() },
      { type: 'divider' },
      { key: 'close', label: '关闭', icon: <CloseOutlined />, disabled: !!me.pinned, onClick: () => closeTab(tabCtx.key) },
      {
        key: 'others',
        label: '关闭其他',
        icon: <CloseCircleOutlined />,
        disabled: !others.length,
        onClick: () => closeMany(others.map((t) => t.key), '关闭其他'),
      },
      {
        key: 'right',
        label: '关闭右侧',
        icon: <ArrowRightOutlined />,
        disabled: !rightOpen.length,
        onClick: () => closeMany(rightOpen.map((t) => t.key), '关闭右侧'),
      },
      { key: 'all', label: '关闭全部', icon: <MinusCircleOutlined />, disabled: !allOpen.length, onClick: () => closeMany(allOpen.map((t) => t.key), '关闭全部') },
    ];
  };

  // 查询页切换连接/库：回写 tab 记录（connId/db/schema 仍是唯一事实源，状态栏/保存/自动连全都跟随）
  const rebindTab = useCallback((key, patch) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }, []);

  const deleteConn = (conn) => {
    Modal.confirm({
      title: `删除连接「${conn.name}」？`,
      content: '仅删除本地保存的连接信息，不影响数据库本身。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        await connApi.remove(conn.id);
        if (sessions[conn.id]) disconnect(conn);
        refreshConns();
      },
    });
  };

  const actions = {
    connect,
    disconnect,
    newConn: () => setConnModal({ open: true, record: null }),
    editConn: (c) => setConnModal({ open: true, record: c }),
    deleteConn,
    refreshTree: () => setSidebarVer((v) => v + 1),
    openTable: ({ connId, db, schema, table }) =>
      openTab({ kind: 'data', connId, db, schema, table, title: table, key: `data:${connId}:${db || ''}|${schema || ''}|${table}` }),
    designTable: ({ connId, db, schema, table, focus }) =>
      openTab({ kind: 'design', connId, db, schema, table, isNew: false, focus, title: `设计 ${table}`, key: `design:${connId}:${db || ''}|${schema || ''}|${table}` }),
    newTable: ({ connId, db, schema }) => {
      tabSeq += 1;
      openTab({ kind: 'design', connId, db, schema, table: '', isNew: true, title: '新建表', key: `design:new:${tabSeq}` });
    },
    newQuery: ({ connId, db, schema }) => {
      tabSeq += 1;
      openTab({ kind: 'query', connId, db, schema, title: `查询 ${tabSeq}`, key: `query:${tabSeq}` });
    },
    openSavedQuery: (q) => {
      tabSeq += 1;
      openTab({
        kind: 'query',
        connId: q.connId,
        db: q.db,
        schema: q.schema,
        qid: q.id,
        qname: q.name,
        initialText: q.text,
        title: q.name,
        key: `query:${tabSeq}`,
      });
    },
    openQueries: () => setSavedQueriesOpen(true),
    openDdl: ({ connId, db, schema, kind, name, table, original, rtype, droptime, refreshKey }) =>
      openTab({
        kind: 'ddl',
        connId,
        db,
        schema,
        objKind: kind,
        name,
        table, // 索引等表级对象的所属表（mssql 合成/删除 DDL 需要）
        original, // 回收站对象的原始名/类型/删除时间（信息展示）
        rtype,
        droptime,
        refreshKey,
        title: name,
        key: `ddl:${connId}:${kind}:${db || ''}|${schema || ''}|${name}`,
      }),
    openObjEdit: ({ connId, db, schema, kind, name, isNew, refreshKey }) => {
      tabSeq += 1;
      openTab({
        kind: 'objedit',
        objKind: kind, // 对象种类（view/function/...）；tab 类型是 objedit
        connId,
        db,
        schema,
        name,
        isNew: !!isNew,
        refreshKey,
        title: (isNew ? '新建' : '编辑') + (KIND_CN[kind] || kind) + (isNew ? '' : ' ' + name),
        key: `objedit:${tabSeq}`,
      });
    },
    openRedis: ({ connId, dbIdx }) =>
      openTab({ kind: 'redis', connId, dbIdx, title: `db${dbIdx}`, key: `redis:${connId}:${dbIdx}` }),
    newView: ({ connId, db, schema, refreshKey }) => {
      tabSeq += 1;
      openTab({ kind: 'vdesign', connId, db, schema, isNew: true, refreshKey, title: '新建视图', key: `vdesign:new:${tabSeq}` });
    },
    designView: ({ connId, db, schema, name, refreshKey }) =>
      openTab({ kind: 'vdesign', connId, db, schema, name, isNew: false, refreshKey, title: `设计视图 ${name}`, key: `vdesign:${connId}:${db || ''}|${schema || ''}|${name}` }),
    openUsers: ({ connId }) =>
      openTab({ kind: 'users', connId, title: '用户管理', key: `users:${connId}` }),
    // 工具栏「表/视图」：打开（或聚焦）对象列表页——展示已有对象清单，不是新建；新建入口在页内
    openObjs: ({ connId, db, schema, kind }) => {
      const patch = { connId, db: db || '', schema: schema || '', objKind: kind || 'table' };
      openTab({ kind: 'objs', key: 'objs:main', title: objsTitleOf(patch), ...patch });
    },
    openEr: ({ connId, db, schema, tables, modelName }) =>
      openTab({
        kind: 'er',
        connId,
        db,
        schema,
        initTables: tables,
        modelName,
        title: modelName ? `模型 · ${modelName}` : `ER 图${db || schema ? ` · ${db || schema}` : ''}`,
        key: modelName ? `er:${connId}:m:${modelName}` : `er:${connId}:${db || ''}|${schema || ''}`,
      }),
    openBackups: () => openTab({ kind: 'backups', title: '备份计划', key: 'backups:main' }),
    // 结构同步：单实例页签；入口带 preset（源连接/库）时回写页签记录并聚焦
    openSync: (preset) =>
      openTab({ kind: 'sync', title: '结构同步', key: 'sync:main', preset: preset || null }),
    // 数据同步：同样单实例页签；与结构共享 preset 语义（源连接/库/schema）
    openDataSync: (preset) =>
      openTab({ kind: 'datasync', title: '数据同步', key: 'datasync:main', preset: preset || null }),
    // 运行 SQL 文件（还原备份）：单实例页签；preset 可带 connId/db/schema/file 预填
    openRestore: (preset) =>
      openTab({ kind: 'restore', title: '运行 SQL 文件', key: 'restore:main', preset: preset || null }),
    openImport: (ctx) => setImportState({ mode: 'new', ...ctx }),
  };

  const connName = (id) => (findConn(id) || {}).name || '';
  const activeTab = tabs.find((t) => t.key === activeKey);

  // ---- 顶部工具栏的目标上下文：树中选中的库/表 → 当前活动标签页 → 首个已打开的关系型连接（未打开连接时全部禁用） ----
  const REL_TYPES = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mssql', 'oracle'];
  const connTypeOf = (id) => (findConn(id) || {}).type || '';
  const tbCtx = (() => {
    if (treeSel && REL_TYPES.includes(connTypeOf(treeSel.connId)) && sessions[treeSel.connId]) return treeSel;
    if (activeTab && activeTab.connId && REL_TYPES.includes(connTypeOf(activeTab.connId)) && sessions[activeTab.connId]) return activeTab;
    const openId = Object.keys(sessions).find((i) => REL_TYPES.includes(connTypeOf(i)));
    return openId ? { connId: openId, db: '', schema: '' } : null;
  })();
  const tbNeedConn = !!tbCtx; // 新建查询 / 用户
  const tbNeedDb = !!tbCtx && (!!(tbCtx.db || tbCtx.schema) || connTypeOf(tbCtx.connId) === 'sqlite'); // 表 / 视图
  // ER 图：选中具体表（树中选中表/视图节点，或活动标签页是表数据页）后可用
  const tbErCtx = (() => {
    if (treeSel && treeSel.table && REL_TYPES.includes(connTypeOf(treeSel.connId))) return treeSel;
    if (activeTab && activeTab.table && activeTab.connId && REL_TYPES.includes(connTypeOf(activeTab.connId))) return activeTab;
    return null;
  })();

  // 对象列表页标题：类型 · 目标库（sqlite 无库层，用连接名）
  const objsTitleOf = (o) => `${o.objKind === 'view' ? '视图' : '表'} · ${o.db || o.schema || connName(o.connId) || ''}`;

  // 对象列表页内切换类型/目标库：回写 tab 记录并同步标题
  const rebindObjs = (key, patch) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.key !== key) return t;
        const n = { ...t, ...patch };
        n.title = objsTitleOf(n);
        return n;
      })
    );
  };

  // 对象列表页跟随树选择：选中其他库/schema/分类/表时自动切换目标（不抢焦点）。
  // sqlite 无库层（db/schema 恒空）——树点它的任意分类/表节点也算有效目标
  useEffect(() => {
    if (!treeSel) return;
    if (!(treeSel.db || treeSel.schema || connTypeOf(treeSel.connId) === 'sqlite')) return;
    if (!REL_TYPES.includes(connTypeOf(treeSel.connId))) return;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.kind !== 'objs') return t;
        if (t.connId === treeSel.connId && (t.db || '') === (treeSel.db || '') && (t.schema || '') === (treeSel.schema || '')) return t;
        const n = { ...t, connId: treeSel.connId, db: treeSel.db || '', schema: treeSel.schema || '' };
        n.title = objsTitleOf(n);
        return n;
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeSel]);

  // 其他组件（如源码查看页）请求打开对象编辑器；查询编辑器右键「补全设置…」请求打开设置面板
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const h = (e) => {
      const d = e.detail || {};
      actionsRef.current.openObjEdit(d);
    };
    window.addEventListener('dh-open-objedit', h);
    return () => window.removeEventListener('dh-open-objedit', h);
  }, []);
  useEffect(() => {
    const h = () => setAcSetOpen(true);
    window.addEventListener('dh-open-acset', h);
    return () => window.removeEventListener('dh-open-acset', h);
  }, []);

  // 鼠标中键关闭标签（antd Tabs 原生不提供）；固定页签受保护；右键弹标签菜单
  const tabHostRef = useRef(null);
  const onTabMouseDown = (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const tab = e.target.closest ? e.target.closest('.ant-tabs-tab') : null;
    const keyEl = tab && tab.querySelector('[data-tab-key]');
    if (keyEl && keyEl.dataset.tabPin !== '1') closeTab(keyEl.dataset.tabKey);
  };
  const onTabContextMenu = (e) => {
    const tab = e.target.closest ? e.target.closest('.ant-tabs-tab') : null;
    if (!tab) return;
    e.preventDefault();
    const keyEl = tab.querySelector('[data-tab-key]');
    if (keyEl) setTabCtx({ x: e.clientX, y: e.clientY, key: keyEl.dataset.tabKey });
  };

  // 关窗协商：主进程拦截 close 后发 dh-close-request；无脏标签直接退出，有脏弹确认
  useEffect(() => {
    if (!appApi || !appApi.onCloseRequest) return undefined;
    appApi.onCloseRequest(() => {
      const dirty = tabsRef.current.some((t) => t.dirty);
      if (!dirty) {
        appApi.confirmClose();
        return;
      }
      Modal.confirm({
        title: '有未保存的修改',
        content: '退出将丢失所有未保存的更改。确定要退出吗？',
        okText: '放弃并退出',
        okType: 'danger',
        cancelText: '取消',
        transitionName: '',
        maskTransitionName: '',
        onOk: () => appApi.confirmClose(),
      });
    });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: '#0e8a6a', borderRadius: 3 },
      }}
    >
      <div className={dark ? 'app-shell dark' : 'app-shell'}>
        <DhCrashProbe />
        <div className="top-toolbar">
          <Button size="small" type="text" className="tb-btn" icon={<ApiOutlined />} title="新建数据库连接" onClick={actions.newConn}>
            连接
          </Button>
          <span className="tb-sep" />
          <Button
            size="small"
            type="text"
            className="tb-btn"
            icon={<FileAddOutlined />}
            disabled={!tbNeedConn}
            title={tbNeedConn ? '新建查询' : '请先打开数据库连接'}
            onClick={() => tbCtx && actions.newQuery({ connId: tbCtx.connId, db: tbCtx.db || '', schema: tbCtx.schema || '' })}
          >
            新建查询
          </Button>
          <Button size="small" type="text" className="tb-btn" icon={<UnorderedListOutlined />} title="已保存的查询列表" onClick={actions.openQueries}>
            查询列表
          </Button>
          <span className="tb-sep" />
          <Button
            size="small"
            type="text"
            className="tb-btn"
            icon={<TableOutlined />}
            disabled={!tbNeedDb}
            title={tbNeedDb ? '查看选中（或活动标签页）的库的表列表' : tbCtx ? '请先在左侧树中选择数据库，或打开表' : '请先打开数据库连接'}
            onClick={() => tbCtx && actions.openObjs({ connId: tbCtx.connId, db: tbCtx.db || '', schema: tbCtx.schema || '', kind: 'table' })}
          >
            表
          </Button>
          <Button
            size="small"
            type="text"
            className="tb-btn"
            icon={<EyeOutlined />}
            disabled={!tbNeedDb}
            title={tbNeedDb ? '查看选中（或活动标签页）的库的视图列表' : tbCtx ? '请先在左侧树中选择数据库，或打开表' : '请先打开数据库连接'}
            onClick={() => tbCtx && actions.openObjs({ connId: tbCtx.connId, db: tbCtx.db || '', schema: tbCtx.schema || '', kind: 'view' })}
          >
            视图
          </Button>
          <Button
            size="small"
            type="text"
            className="tb-btn"
            icon={<ApartmentOutlined />}
            disabled={!tbErCtx}
            title={tbErCtx ? `查看「${tbErCtx.db || tbErCtx.schema || ''}」的 ER 图` : '请先在左侧树中选择表'}
            onClick={() => tbErCtx && actions.openEr({ connId: tbErCtx.connId, db: tbErCtx.db || '', schema: tbErCtx.schema || '' })}
          >
            ER 图
          </Button>
          <Button
            size="small"
            type="text"
            className="tb-btn"
            icon={<TeamOutlined />}
            disabled={!tbNeedConn}
            title={tbNeedConn ? '用户管理' : '请先打开数据库连接'}
            onClick={() => tbCtx && actions.openUsers({ connId: tbCtx.connId })}
          >
            用户
          </Button>
          <span className="tb-sep" />
          <Button size="small" type="text" className="tb-btn" icon={<DiffOutlined />} title="结构同步：比较两个库的表结构差异并应用" onClick={() => actions.openSync(tbCtx ? { connId: tbCtx.connId, db: tbCtx.db || '', schema: tbCtx.schema || '' } : null)}>
            结构同步
          </Button>
          <Button size="small" type="text" className="tb-btn" icon={<DatabaseOutlined />} title="数据同步：比较两个库的表数据差异（按主键）并应用" onClick={() => actions.openDataSync(tbCtx ? { connId: tbCtx.connId, db: tbCtx.db || '', schema: tbCtx.schema || '' } : null)}>
            数据同步
          </Button>
          <Button size="small" type="text" className="tb-btn" icon={<HddOutlined />} title="备份与恢复" onClick={actions.openBackups}>
            备份
          </Button>
        </div>
        <div className="app-main">
          <Sidebar
            conns={conns}
            sessions={sessions}
            actions={actions}
            ver={sidebarVer}
            dark={dark}
            onToggleDark={() => setDark((d) => !d)}
            onTreeSel={setTreeSel}
          />
          <div className="main-area" ref={tabHostRef} onMouseDown={onTabMouseDown} onContextMenu={onTabContextMenu}>
            {tabs.length === 0 ? (
              <div className="empty-pane">
                <div className="empty-logo"><AppIcon size={46} /></div>
                <div style={{ fontSize: 15 }}>DataHelm · 数据库管理</div>
                <div className="empty-hint">左侧双击连接打开；还没有连接就点上方「新建连接」</div>
              </div>
            ) : (
              <Tabs
                hideAdd
                type="editable-card"
                size="small"
                className="main-tabs"
                activeKey={activeKey}
                onChange={setActiveKey}
                onEdit={(k, a) => a === 'remove' && closeTab(k)}
                items={tabs.map((t) => ({
                  key: t.key,
                  label: (
                    <span
                      data-tab-key={t.key}
                      data-tab-pin={t.pinned ? '1' : undefined}
                      draggable
                      onDragStart={(e) => {
                        dragTabRef.current = t.key;
                        if (e.dataTransfer) {
                          e.dataTransfer.effectAllowed = 'move';
                          try { e.dataTransfer.setData('text/plain', t.title); } catch {}
                        }
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const src = dragTabRef.current;
                        dragTabRef.current = null;
                        if (src) moveTab(src, t.key);
                      }}
                      onDragEnd={() => { dragTabRef.current = null; }}
                    >
                      {t.pinned ? <PushpinFilled className="tab-pin" /> : null}
                      {t.title}
                      {t.dirty ? <span className="tab-dot" title="有未保存的修改" /> : null}
                    </span>
                  ),
                  closable: !t.pinned,
                  children:
                    t.kind === 'data' ? (
                      <DataTab {...t} active={t.key === activeKey} connName={connName(t.connId)} onStatus={setStatus} onChanged={actions.refreshTree} onOpenImport={(ctx) => setImportState({ ...ctx, connId: t.connId, db: t.db, schema: t.schema })} />
                    ) : t.kind === 'design' ? (
                      <DesignTab {...t} connName={connName(t.connId)} session={sessions[t.connId]} onStatus={setStatus} onChanged={actions.refreshTree} onClose={() => closeTab(t.key)} onDirtyChange={(d) => setTabDirty(t.key, d)} />
                    ) : t.kind === 'ddl' ? (
                      <DdlTab {...t} connName={connName(t.connId)} onStatus={setStatus} onClose={() => closeTab(t.key)} />
                    ) : t.kind === 'redis' ? (
                      <RedisTab {...t} connName={connName(t.connId)} onStatus={setStatus} />
                    ) : t.kind === 'objedit' ? (
                      <ObjEditTab {...t} dark={dark} kind={t.objKind} connName={connName(t.connId)} session={sessions[t.connId]} onStatus={setStatus} onClose={() => closeTab(t.key)} />
                    ) : t.kind === 'objs' ? (
                      <ObjListTab
                        {...t}
                        connType={connTypeOf(t.connId)}
                        connName={connName(t.connId)}
                        active={t.key === activeKey}
                        actions={actions}
                        onStatus={setStatus}
                        onChanged={actions.refreshTree}
                        onRebind={(patch) => rebindObjs(t.key, patch)}
                      />
                    ) : t.kind === 'vdesign' ? (
                      <ViewDesignTab {...t} connName={connName(t.connId)} session={sessions[t.connId]} onStatus={setStatus} onClose={() => closeTab(t.key)} onDirtyChange={(dd) => setTabDirty(t.key, dd)} />
                    ) : t.kind === 'users' ? (
                      <UsersTab {...t} connName={connName(t.connId)} session={sessions[t.connId]} onStatus={setStatus} />
                    ) : t.kind === 'er' ? (
                      <ErTab {...t} connName={connName(t.connId)} onStatus={setStatus} />
                    ) : t.kind === 'backups' ? (
                      <BackupsTab conns={conns} onStatus={setStatus} onRestore={actions.openRestore} />
                    ) : t.kind === 'sync' ? (
                      <SyncTab conns={conns} preset={t.preset} onConnect={connect} onStatus={setStatus} onChanged={actions.refreshTree} />
                    ) : t.kind === 'datasync' ? (
                      <DataSyncTab conns={conns} preset={t.preset} onConnect={connect} onStatus={setStatus} onChanged={actions.refreshTree} />
                    ) : t.kind === 'restore' ? (
                      <RestoreTab conns={conns} preset={t.preset} onConnect={connect} onStatus={setStatus} onChanged={actions.refreshTree} />
                    ) : (
                      <QueryTab
                        {...t}
                        dark={dark}
                        connName={connName(t.connId)}
                        session={sessions[t.connId]}
                        onStatus={setStatus}
                        onDirtyChange={(d) => setTabDirty(t.key, d)}
                        conns={conns}
                        sessions={sessions}
                        onConnect={connect}
                        onBindChange={(patch) => rebindTab(t.key, patch)}
                        onCodeSync={(c) => { codeSyncRef.current[t.key] = c; }}
                      />
                    ),
                }))}
              />
            )}
          </div>
        </div>
        <div className="statusbar">
          <span>
            {Object.keys(sessions).length}/{conns.length} 个连接
            {activeTab ? ` · ${connName(activeTab.connId)}${sessions[activeTab.connId] ? ' · ' + sessions[activeTab.connId].serverInfo : ''}` : ' · DataHelm'}
            <span style={{ color: '#bbb', marginLeft: 8 }}>v0927.53</span>
          </span>
          <span className="sb-right">
            <Button
              size="small"
              type="text"
              className="sb-acset"
              icon={<SettingOutlined />}
              title="补全设置：自定义代码片段与补全开关"
              data-dh-cs="open"
              onClick={() => setAcSetOpen(true)}
            />
            {status}
          </span>
        </div>
      </div>
      <InputContextMenu />
      {tabCtx && <FloatMenu x={tabCtx.x} y={tabCtx.y} items={tabCtxItems()} onClose={() => setTabCtx(null)} />}
      <Modal
        open={!!rename}
        title="重命名标签页"
        okText="确定"
        cancelText="取消"
        transitionName=""
        maskTransitionName=""
        onOk={applyRename}
        onCancel={() => setRename(null)}
        destroyOnClose
      >
        <Input
          value={rename ? rename.value || '' : ''}
          onChange={(e) => setRename((r) => (r ? { ...r, value: e.target.value } : r))}
          onPressEnter={applyRename}
          placeholder="输入新的标签名称"
          maxLength={80}
          autoFocus
        />
      </Modal>
      <ConnectionModal
        open={!!(connModal && connModal.open)}
        record={connModal && connModal.record}
        onClose={() => {
          setConnModal(null);
          refreshConns();
        }}
      />
      <SavedQueriesModal open={savedQueriesOpen} onClose={() => setSavedQueriesOpen(false)} onOpenQuery={actions.openSavedQuery} />
      <CompletionSettingsModal open={acSetOpen} onClose={() => setAcSetOpen(false)} />
      {importState && (
        <ImportWizard
          state={importState}
          conns={conns}
          onClose={() => setImportState(null)}
          onChanged={actions.refreshTree}
        />
      )}
    </ConfigProvider>
  );
}

const KIND_CN = { view: '视图', function: '函数', procedure: '存储过程', trigger: '触发器', event: '事件', sequence: '序列' };
