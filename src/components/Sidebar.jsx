import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Empty, Input, Menu, Modal, Radio, Select, Space, Tree, message } from 'antd';
import {
  ApartmentOutlined, AppstoreOutlined, ClockCircleOutlined, CloudOutlined, CodeOutlined, CoffeeOutlined,
  CopyOutlined, DatabaseOutlined, DeleteOutlined, DeploymentUnitOutlined, DiffOutlined, EditOutlined, ExportOutlined, EyeOutlined, FieldBinaryOutlined,
  CheckCircleOutlined, FieldNumberOutlined, FieldStringOutlined, FieldTimeOutlined, FileTextOutlined, FolderOutlined,
  FunctionOutlined, HistoryOutlined, HddOutlined, ImportOutlined, InfoCircleOutlined, KeyOutlined, LinkOutlined,
  MoonOutlined, NumberOutlined, OrderedListOutlined, PlayCircleOutlined, PlusOutlined, ProfileOutlined, ReloadOutlined, RestOutlined,
  SafetyCertificateOutlined, ScheduleOutlined, SaveOutlined, SearchOutlined, SettingOutlined, SwapOutlined, SunOutlined,
  TableOutlined, TagOutlined, ThunderboltOutlined, UndoOutlined,
} from '@ant-design/icons';
import { dbApi, dbTransfer, copyText, pickFile, modelApi } from '../api';
import DbIcon, { DbCylIcon } from './DbIcons';
import DumpModal from './DumpModal';
import ExportModal from './ExportModal';
import FloatMenu from './FloatMenu';

const TYPE_LABEL = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite', mssql: 'SQL Server', mongo: 'MongoDB', redis: 'Redis', oracle: 'Oracle' };
const RELATIONAL = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mssql', 'oracle'];
const USER_TYPES = ['mysql', 'mariadb', 'postgres'];
const OBJ_ICON = {
  function: CodeOutlined, procedure: CodeOutlined, trigger: ThunderboltOutlined, event: ClockCircleOutlined,
  sequence: OrderedListOutlined, index: ProfileOutlined, type: AppstoreOutlined, synonym: TagOutlined,
  pubsynonym: TagOutlined, package: FunctionOutlined, mviewlog: HistoryOutlined, dblink: LinkOutlined,
  pubdblink: LinkOutlined, tablespace: HddOutlined, javasrc: CoffeeOutlined, xmlschema: FileTextOutlined,
};
const OBJ_KINDS = ['function', 'procedure', 'trigger', 'event', 'sequence', 'index', 'type', 'synonym', 'pubsynonym', 'package', 'mviewlog', 'dblink', 'pubdblink', 'tablespace', 'javasrc', 'xmlschema'];
// 表展开的结构分组（与对象列表结构面板/设计器同口径）：视图只展示字段
const TSTRUCT = { fields: '字段', indexes: '索引', fkeys: '外键', uniques: '唯一键', checks: '检查', triggers: '触发器' };
const TSTRUCT_KINDS = Object.keys(TSTRUCT);
// 分组下明细行的类型 -> 图标（索引/外键/唯一键/检查/触发器；字段行走 ColIcon）
const TSTRUCT_LEAF = { idx: ProfileOutlined, fk: LinkOutlined, uq: SafetyCertificateOutlined, ck: CheckCircleOutlined, tg: ThunderboltOutlined };
// 明细行右键删除：中文名 + dropStruct 的 kind（sqlite 唯一键=唯一索引由 dropStructSql 按方言归一）
const TSTRUCT_CN = { idx: '索引', fk: '外键', uq: '唯一键', ck: '检查', tg: '触发器' };
const TSTRUCT_DROP = { idx: 'index', fk: 'fkey', uq: 'unique', ck: 'check', tg: 'trigger' };
// 索引/唯一键同源的驱动（唯一索引直接归「唯一键」组）；postgres/mssql 有独立 uniques 元数据
const IDX_AS_UQ = ['sqlite', 'mysql', 'mariadb'];
const UQ_KIND = ['postgres', 'mssql'];
// 有「新建/编辑」SQL 模板的种类（其余目录只读：查看源码/删除）
const NEWABLE_KINDS = ['view', 'function', 'procedure', 'trigger', 'event', 'sequence', 'synonym', 'dblink', 'type', 'package'];
const KIND_CN = {
  table: '表', view: '视图', function: '函数', procedure: '存储过程', trigger: '触发器', event: '事件', sequence: '序列',
  index: '索引', type: '类型', synonym: '同义词', pubsynonym: '公用同义词', package: '包', mviewlog: '实体化视图日志',
  dblink: '数据库链接', pubdblink: '公用数据库链接', tablespace: '表空间', javasrc: 'Java 源码', xmlschema: 'XML 架构',
};

// 库/schema 节点用「多层圆柱」数据库图标（Navicat 观感）；连接行才是品牌 logo，分类用文件夹
// 字段行：主键金色钥匙；其余按数据类型取 Field* 图标（近似 Navicat 的字段图标观感）
function ColIcon({ node }) {
  if (node.pk) return <KeyOutlined className="col-ic-pk" />;
  const dt = String(node.dt || '').toLowerCase();
  if (/int|decimal|numeric|float|double|real|number|bit|money|serial/.test(dt)) return <FieldNumberOutlined />;
  if (/date|time/.test(dt)) return <FieldTimeOutlined />;
  if (/byte|binary|blob|image|raw|uuid|uniqueid/.test(dt)) return <FieldBinaryOutlined />;
  return <FieldStringOutlined />;
}

function NodeIcon({ node }) {
  if (node.type === 'db' || node.type === 'schema') return <DbCylIcon />;
  if (node.type === 'table') return <TableOutlined />;
  if (node.type === 'view') return <EyeOutlined />;
  if (node.type === 'column') return <ColIcon node={node} />;
  if (TSTRUCT_LEAF[node.type]) { const Ico = TSTRUCT_LEAF[node.type]; return <Ico />; }
  if (node.type === 'model') return <DeploymentUnitOutlined />;
  if (node.type === 'recycle') return <RestOutlined />;
  const Ico = OBJ_ICON[node.type];
  if (Ico) return <Ico />;
  return <FolderOutlined />;
}

export default function Sidebar({ conns, sessions, actions, ver, dark, onToggleDark, onTreeSel }) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState([]);
  const [children, setChildren] = useState({}); // key -> 子节点数组（含 key/connId）
  const [prompt, setPrompt] = useState(null); // {title, label, value, onOk}
  const [transfer, setTransfer] = useState(null); // {connId, db, schema, table}
  const [dump, setDump] = useState(null); // 数据库导出弹窗 {connId, db, schema, tables?, lockTables?, title?}
  const [ctxMenu, setCtxMenu] = useState(null); // {x, y, node} 右键菜单（整行触发）
  const [expState, setExpState] = useState(null); // 导出数据弹窗（表右键）
  const titleEls = useRef(new Map()); // .node-title DOM 元素 -> 节点数据（双击委托用）

  // 调试标记（ui-debug.log 落盘）：版本确认 + 渲染/异步错误捕获（含 stack，便于离线定位）
  useEffect(() => {
    console.log('DH-UI-VER v0927.53 库节点菜单 db 兜底：mssql/mysql/mongo 库节点右键的新建查询/新建表(集合)/数据传输/导出数据库/结构同步/数据同步/ER 图，库名取 node.name（此前 db 为空落到会话默认库——修复「选 A 库导出却列出 master 的表」）；v0927.52 五合一：①对象列表页 MSSQL 多架构——默认列全部架构（行带架构列、打开/设计/删除按行架构透传），新增架构下拉可切 dbo/非 dbo；②sp_rename 全面纯点分路径；③结果对比基准多快照管理；④表设计器重建表路径的他表外键引用限制提示；⑤查询历史搜索与收藏。');
    const onErr = (ev) => {
      const stack = ev.error && ev.error.stack ? ' | STACK ' + String(ev.error.stack).slice(0, 700) : '';
      console.log('DH-ERR ' + ev.message + stack);
    };
    window.addEventListener('error', onErr);
    return () => window.removeEventListener('error', onErr);
  }, []);

  // 右键菜单的关闭行为：点菜单外 / ESC（自渲染 Menu，无 Dropdown 的自动关闭）
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e) => {
      if (!e.target.closest || !e.target.closest('.ctx-menu')) setCtxMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [ctxMenu]);

  useEffect(() => {
    // 外部请求刷新（结构变更后）：清空子级缓存，按原展开状态重拉各节点，树不再整体折叠
    setChildren({});
    expanded.forEach((k) => {
      const nd = nodeByKeyRef.current.get(k);
      if (nd) loadChildren(k, nd).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver]);

  const connOf = useCallback((connId) => conns.find((c) => c.id === connId), [conns]);

  const assignKeys = (parentKey, connId, nodes) =>
    nodes.map((nd) => ({ ...nd, connId, key: `${parentKey}/${nd.type === 'cat' ? 'cat' + nd.kind : nd.type}:${nd.name}` }));

  const nodeByKeyRef = useRef(new Map()); // key -> 节点数据（刷新时按原展开状态重拉）

  const loadChildren = useCallback(
    async (key, node) => {
      const connId = node.connId;
      nodeByKeyRef.current.set(key, node);
      let raw;
      if (node.type === 'conn') {
        raw = await dbApi(connId, 'treeRoot');
        // 关系型连接追加「模型」目录（保存的 ER 模型，应用层存储而非驱动内省）
        const conn = connOf(connId);
        if (conn && RELATIONAL.includes(conn.type)) {
          raw = [...raw, { type: 'cat', kind: 'model', name: '模型' }];
        }
      } else if (node.type === 'cat' && node.kind === 'model') {
        raw = (await modelApi.list(connId)).map((m) => ({
          type: 'model', connId, db: m.db, schema: m.schema, name: m.name, tables: m.tables, modelId: m.id,
        }));
      } else if (node.type === 'table' || node.type === 'view') {
        // 表/视图展开 → 结构分组（字段/索引/外键/唯一键/检查/触发器；视图只展示字段）
        raw = (node.type === 'view' ? ['fields'] : TSTRUCT_KINDS).map((k) => ({
          type: 'cat', kind: k, db: node.db, schema: node.schema, table: node.name, name: TSTRUCT[k], srcView: node.type === 'view',
        }));
      } else if (node.type === 'cat' && TSTRUCT_KINDS.includes(node.kind)) {
        // 分组展开 → 该类明细（口径与 ObjListTab 结构面板一致：sqlite/mysql 唯一索引归唯一键；PK 后备索引不列）
        const conn = connOf(connId);
        const ct = conn ? conn.type : '';
        const args = { db: node.db, schema: node.schema, table: node.table };
        const base = { db: node.db, schema: node.schema, table: node.table };
        if (node.kind === 'fields') {
          const cols = await dbApi(connId, 'columns', args);
          raw = cols.map((c) => ({ ...base, type: 'column', name: c.name, pk: !!c.pk, dt: c.display || c.dataType || '', isView: !!node.srcView }));
        } else if (node.kind === 'indexes') {
          const xs = (await dbApi(connId, 'indexes', args)).filter((x) => String(x.origin || 'c') !== 'pk');
          raw = xs.filter((x) => !(IDX_AS_UQ.includes(ct) && x.unique))
            .map((x) => ({ ...base, type: 'idx', name: x.name, detail: `${x.name}（${(x.columns || []).join(', ')}）` }));
        } else if (node.kind === 'uniques') {
          const xs = IDX_AS_UQ.includes(ct)
            ? (await dbApi(connId, 'indexes', args)).filter((x) => String(x.origin || 'c') !== 'pk' && x.unique)
                .map((x) => ({ name: x.name, columns: x.columns || [] }))
            : UQ_KIND.includes(ct)
              ? (await dbApi(connId, 'uniques', args)).map((x) => ({ name: x.name, columns: x.columns || [], clustered: !!x.clustered }))
              : [];
          raw = xs.map((x) => ({ ...base, type: 'uq', name: x.name, detail: `${x.name}（${(x.columns || []).join(', ')}）${x.clustered ? ' · 聚集' : ''}` }));
        } else if (node.kind === 'fkeys') {
          raw = (await dbApi(connId, 'fkeys', args)).map((x) => ({
            ...base, type: 'fk', name: x.name,
            detail: `${x.name}：${(x.columns || []).join(', ')} → ${x.refSchema ? x.refSchema + '.' : ''}${x.refTable}(${(x.refColumns || []).join(', ')})`,
          }));
        } else if (node.kind === 'checks') {
          // sqlite/mysql 的 CHECK 匿名：用序号合成展示名（仅界面显示，不可按名删除）
          raw = (await dbApi(connId, 'checks', args)).map((x, i) => ({
            ...base, type: 'ck', name: x.name || `CHECK_${i + 1}`, anon: !x.name, detail: `${x.name ? x.name + '：' : ''}${x.expr}`,
          }));
        } else {
          raw = (await dbApi(connId, 'triggers', args)).map((x) => ({
            ...base, type: 'tg', name: x.name, detail: [x.name, x.timing, x.event].filter(Boolean).join(' · '),
          }));
        }
      } else {
        raw = await dbApi(connId, 'treeChildren', node);
      }
      const kids = assignKeys(key, connId, raw);
      setChildren((prev) => ({ ...prev, [key]: kids }));
      return kids;
    },
    [connOf]
  );

  // 展开时按需加载子节点（onExpand 与双击 toggle 共用）
  const expandLoad = useCallback(
    (key, node) => {
      const fail = (e) => message.error(`加载失败：${e.message}`);
      if (node.type === 'conn') {
        if (!sessions[node.connId]) {
          const conn = connOf(node.connId);
          actions.connect(conn).then(() => loadChildren(key, node)).catch(fail);
        } else if (!children[key]) {
          loadChildren(key, node).catch(fail);
        }
        return;
      }
      if ((node.type === 'db' || node.type === 'schema' || node.type === 'cat' || node.type === 'table' || node.type === 'view') && !children[key]) {
        loadChildren(key, node).catch(fail);
      }
    },
    [actions, children, connOf, loadChildren, sessions]
  );

  // 双击容器节点：展开/收起切换
  const toggleNode = (key, node) => {
    const isOpen = expanded.includes(key);
    setExpanded((prev) => (isOpen ? prev.filter((k) => k !== key) : [...prev, key]));
    if (!isOpen) expandLoad(key, node);
  };

  function refreshNode(key, node) {
    setChildren((prev) => {
      const n = {};
      for (const [k, v] of Object.entries(prev)) {
        if (k !== key && !k.startsWith(key + '/')) n[k] = v;
      }
      return n;
    });
    loadChildren(key, node).catch(() => {});
  }

  function findNodeData(key) {
    // 连接键形如 c:<connId>（无斜杠）；c:<connId>/catview:视图 等子键必须走路径查找，
    // 否则整键被当成 connId，刷新时 dbApi 报“连接未打开”，子级被清空后不再重载
    if (key.startsWith('c:') && !key.slice(2).includes('/')) return { type: 'conn', connId: key.slice(2) };
    const path = key.split('/');
    let list = children[`c:${path[0].slice(2)}`] || [];
    let cur = null;
    for (let i = 1; i < path.length; i++) {
      cur = list.find((x) => x.key === path.slice(0, i + 1).join('/'));
      if (!cur) return null;
      list = children[cur.key] || [];
    }
    return cur;
  }

  function refreshNodeOf(node) {
    const idx = node.key.lastIndexOf('/');
    const parentKey = idx === -1 ? `c:${node.connId}` : node.key.slice(0, idx);
    const parentNode = findNodeData(parentKey);
    if (parentNode) refreshNode(parentKey, parentNode);
  }

  const parentKeyOfNode = (node) => {
    const idx = node.key.lastIndexOf('/');
    return idx === -1 ? node.key : node.key.slice(0, idx);
  };

  // 对象编辑器保存成功后的事件（App 里 dispatch）
  useEffect(() => {
    const h = (e) => {
      const key = e.detail && e.detail.refreshKey;
      if (!key) return;
      const node = findNodeData(key);
      if (node) refreshNode(key, node);
    };
    window.addEventListener('dh-refresh-tree', h);
    return () => window.removeEventListener('dh-refresh-tree', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  // 树数据（连接 -> 库/模式 -> 分类 -> 对象 -> 结构分组 -> 明细行）
  // 关系型的表/视图展开出结构分组（视图只有字段）；mongo/redis 的表(集合)保持叶子（columns 内省不适用）
  const relConnOf = useCallback((cid) => { const c = connOf(cid); return !!(c && RELATIONAL.includes(c.type)); }, [connOf]);
  const treeData = useMemo(() => {
    const isLeafOf = (nd) => {
      if (nd.type === 'table' || nd.type === 'view') return !relConnOf(nd.connId);
      return ['column', ...Object.keys(TSTRUCT_LEAF), 'model', 'recycle', ...OBJ_KINDS].includes(nd.type);
    };
    const build = (key, nd, titleExtra) => {
      const item = {
        key,
        node: nd,
        icon: <NodeIcon node={nd} />,
        title: titleExtra,
        isLeaf: isLeafOf(nd),
      };
      const kids = children[key];
      if (kids) {
        item.children = kids.map((k) => build(k.key, k, renderTitle(k)));
      }
      return item;
    };
    return conns.map((c) => {
      const key = `c:${c.id}`;
      const item = {
        key,
        node: { type: 'conn', connId: c.id, dbtype: c.type, key, cloud: c.cloud },
        icon: <DbIcon type={c.type} />,
        title: renderTitle({ type: 'conn', name: c.name, connId: c.id, dbtype: c.type, key, cloud: c.cloud }),
        isLeaf: false,
      };
      const kids = children[key];
      if (kids) {
        item.children = kids.map((k) => build(k.key, k, renderTitle(k)));
      }
      return item;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, sessions, conns]);

  // ---- 对象树过滤：按名称模糊命中（不区分大小写）；命中节点的祖先链保留并自动展开露出命中；
  // ---- 命中容器整棵子树保留；未展开的连接与未加载的 表/视图 分类保留（可继续下钻，分类会被自动加载） ----
  const treeView = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return { data: treeData, keys: [] };
    const auto = new Set();
    const walk = (items) => {
      const out = [];
      for (const it of items) {
        const nd = it.node || {};
        const self = String(nd.name || '').toLowerCase().includes(q);
        if (nd.type === 'conn') {
          // 连接行无条件保留：命中保整棵子树；未命中保空行（维持导航锚点，不塌树）
          if (self || !it.children) {
            out.push(it);
            continue;
          }
          const ck = walk(it.children);
          if (ck.length) {
            auto.add(it.key);
            out.push({ ...it, children: ck });
          } else {
            out.push({ ...it, children: undefined }); // 无命中：保留裸连接行（不携带未过滤子树）
          }
          continue;
        }
        if (it.children) {
          if (self) {
            out.push(it); // 命中容器：整棵子树原样保留
            continue;
          }
          const kids = walk(it.children);
          if (kids.length) {
            auto.add(it.key); // 因命中子级保留 → 自动展开露出命中行
            out.push({ ...it, children: kids });
          }
          continue;
        }
        if (self) {
          out.push(it);
        } else if (!it.isLeaf && nd.type === 'cat' && (nd.kind === 'table' || nd.kind === 'view')) {
          out.push(it); // 未加载表视图分类：过滤期间保留可下钻（会被自动加载）
        }
      }
      return out;
    };
    return { data: walk(treeData), keys: [...auto] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeData, search]);

  // 过滤激活：自动加载已展开容器下的 表/视图 分类（加载完成后过滤即时重算呈现）；幂等，无风暴
  useEffect(() => {
    if (!search.trim()) return;
    Object.values(children).forEach((list) => {
      list.forEach((nd) => {
        if (nd.type === 'cat' && (nd.kind === 'table' || nd.kind === 'view') && !children[nd.key]) {
          loadChildren(nd.key, nd).catch(() => {});
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, children]);

  // ---- 标题渲染（双击/右键由整行委托处理：tree-wrap onDoubleClick + Tree onRightClick） ----
  function renderTitle(node) {
    const conn = connOf(node.connId);
    const connected = conn && sessions[conn.id];
    return (
      <span
        className={`node-title${node.type === 'conn' && connected ? ' on' : ''}`}
        title={node.detail || (node.type === 'column' ? `${node.name}${node.dt ? ' · ' + node.dt : ''}` : node.name)}
        ref={(el) => {
          if (el) titleEls.current.set(el, node);
          else titleEls.current.delete(el);
        }}
      >
        {node.name}
        {node.type === 'column' && node.dt ? <span className="node-dt">{node.dt}</span> : null}
        {node.type === 'conn' && connected ? <span className="dot" title="已连接" /> : null}
        {node.type === 'conn' && node.cloud ? (
          <span className="cloud-tag" title={node.cloud}>
            <CloudOutlined /> {node.cloud.replace(/（.*$/, '')}
          </span>
        ) : null}
      </span>
    );
  }

  // 树选择 → 工具栏上下文（选中库/schema/分类/表/结构分组/明细行即获得数据库上下文；都归到所属表）
  function selCtxOf(node) {
    if (!node) return null;
    const conn = connOf(node.connId);
    if (!conn || !RELATIONAL.includes(conn.type)) return null;
    const leafTypes = ['column', ...Object.keys(TSTRUCT_LEAF)];
    if (!['db', 'schema', 'cat', 'table', 'view', ...leafTypes].includes(node.type)) return null;
    return {
      connId: node.connId,
      db: node.db || (node.type === 'db' ? node.name : ''),
      schema: node.schema || (node.type === 'schema' ? node.name : ''),
      table: ['table', 'view'].includes(node.type)
        ? node.name
        : leafTypes.includes(node.type) || (node.type === 'cat' && TSTRUCT_KINDS.includes(node.kind))
          ? node.table
          : '',
    };
  }

  function handleDblClick(node, conn) {
    if (node.type === 'conn') {
      if (sessions[conn.id]) {
        actions.disconnect(conn);
      } else {
        const key = node.key || `c:${node.connId}`;
        actions
          .connect(conn)
          .then(() => {
            setExpanded((prev) => (prev.includes(key) ? prev : [...prev, key]));
            return loadChildren(key, { type: 'conn', connId: node.connId });
          })
          .catch((e) => message.error(`加载失败：${e.message}`));
      }
    } else if (node.type === 'db' && conn && conn.type === 'redis') {
      actions.openRedis({ connId: node.connId, dbIdx: node.idx });
    } else if (node.type === 'db' || node.type === 'schema' || node.type === 'cat') {
      toggleNode(node.key, node);
    } else if (node.type === 'table' || node.type === 'view') {
      actions.openTable({ connId: node.connId, db: node.db, schema: node.schema, table: node.name });
    } else if (node.type === 'model') {
      actions.openEr({ connId: node.connId, db: node.db, schema: node.schema, tables: node.tables, modelName: node.name });
    } else if (node.type === 'recycle') {
      actions.openDdl({
        connId: node.connId, kind: 'recycle', name: node.bin,
        original: node.name, rtype: node.rtype, droptime: node.droptime, refreshKey: parentKeyOfNode(node),
      });
    } else if (node.type === 'idx' || node.type === 'fk' || node.type === 'uq' || node.type === 'ck') {
      // 结构明细行双击 = 编辑：打开表设计器并定位到该行所在分区
      actions.designTable({ connId: node.connId, db: node.db, schema: node.schema, table: node.table, focus: { kind: node.type, name: node.name, ts: Date.now() } });
    } else if (node.type === 'tg') {
      actions.openDdl({ connId: node.connId, db: node.db, schema: node.schema, kind: 'trigger', name: node.name, table: node.table, refreshKey: parentKeyOfNode(node) });
    } else if (node.type === 'column' && !node.isView) {
      // 字段明细行双击 = 编辑：打开表设计器字段页并定位高亮该列（视图列无表设计器）
      actions.designTable({ connId: node.connId, db: node.db, schema: node.schema, table: node.table, focus: { kind: 'col', name: node.name, ts: Date.now() } });
    } else if (OBJ_KINDS.includes(node.type)) {
      actions.openDdl({ connId: node.connId, db: node.db, schema: node.schema, kind: node.type, name: node.name, table: node.table, refreshKey: parentKeyOfNode(node) });
    }
  }

  function menuItems(node, conn) {
    const confirmRun = (title, fn, ok) =>
      Modal.confirm({ title, okText: '确定', okType: 'danger', cancelText: '取消', onOk: () => fn().then(ok || (() => {})).catch((e) => message.error(e.message)) });
    const copyTextOk = (label, text) => copyText(text).then(() => message.success(`已复制${label}`));

    const ctx = { connId: node.connId, db: node.db, schema: node.schema, table: node.name };
    const parentKeyOf = () => parentKeyOfNode(node);
    if (node.type === 'conn') {
      const base = [];
      if (sessions[conn.id]) base.push({ key: 'close', label: '关闭连接', icon: <DbIcon type={conn.type} />, onClick: () => actions.disconnect(conn) });
      else base.push({ key: 'open', label: '打开连接', icon: <DbIcon type={conn.type} />, onClick: () => handleDblClick({ type: 'conn', connId: conn.id, key: `c:${conn.id}` }, conn) });
      base.push({ type: 'divider' });
      base.push({ key: 'q', label: '新建查询', icon: <SearchOutlined />, onClick: () => actions.newQuery({ connId: node.connId }) });
      base.push({ key: 'qlist', label: '查询列表（已保存）', icon: <SaveOutlined />, onClick: () => actions.openQueries() });
      if (conn.type !== 'mongo' && conn.type !== 'redis') {
        base.push({ key: 'runsql', label: '运行 SQL 文件…', icon: <PlayCircleOutlined />, onClick: () => actions.openRestore({ connId: node.connId }) });
      }
      if (USER_TYPES.includes(conn.type)) {
        base.push({ key: 'users', label: '用户管理', icon: <InfoCircleOutlined />, onClick: () => actions.openUsers({ connId: node.connId }) });
      }
      if (conn.type !== 'sqlite' && conn.type !== 'redis' && conn.type !== 'oracle') {
        base.push({
          key: 'newdb',
          label: '新建数据库…',
          icon: <PlusOutlined />,
          onClick: () =>
            setPrompt({
              title: '新建数据库',
              label: conn.type === 'mongo' ? '数据库名（将创建 init 集合）' : '数据库名',
              onOk: (v) =>
                dbApi(node.connId, 'createDatabase', v.trim())
                  .then(() => message.success('已创建'))
                  .catch((e) => message.error(e.message)),
            }),
        });
      }
      base.push({ type: 'divider' });
      base.push({ key: 'copy', label: '复制连接名', icon: <CopyOutlined />, onClick: () => copyTextOk('连接名', conn.name) });
      if (sessions[conn.id]) {
        base.push({ key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNode(node.key, { type: 'conn', connId: node.connId }) });
      }
      base.push({ type: 'divider' });
      base.push({ key: 'edit', label: '连接属性', icon: <SettingOutlined />, onClick: () => actions.editConn(conn) });
      base.push({ key: 'del', label: '删除连接', danger: true, onClick: () => actions.deleteConn(conn) });
      return base;
    }
    if (node.type === 'db' || node.type === 'schema') {
      const isRedis = conn && conn.type === 'redis';
      if (isRedis) {
        return [
          { key: 'open', label: '打开键浏览器', icon: <EyeOutlined />, onClick: () => actions.openRedis({ connId: node.connId, dbIdx: node.idx }) },
          {
            key: 'flush',
            label: '清空此 db（FLUSHDB）',
            danger: true,
            onClick: () => confirmRun(`清空 db${node.idx} 的所有键？`, () => dbApi(node.connId, 'dropDatabase', { db: node.idx })),
          },
        ];
      }
      const isMongo = conn && conn.type === 'mongo';
      // mssql/mysql/mongo 的库节点只带 name 不带 db（子级才带）：db 节点库名取 node.name；schema 节点（pg/oracle）仍用 node.db
      const ndb = node.db || (node.type === 'db' ? node.name : undefined);
      const items = [
        { key: 'q', label: '新建查询', icon: <SearchOutlined />, onClick: () => actions.newQuery({ ...ctx, db: ndb }) },
        isMongo
          ? {
              key: 'nt',
              label: '新建集合…',
              icon: <PlusOutlined />,
              onClick: () =>
                setPrompt({
                  title: '新建集合',
                  label: '集合名',
                  onOk: (v) =>
                    dbApi(node.connId, 'createTable', { db: ndb, name: v.trim() })
                      .then(() => { message.success('集合已创建'); actions.refreshTree(); })
                      .catch((e) => message.error(e.message)),
                }),
            }
          : { key: 'nt', label: '新建表', icon: <PlusOutlined />, onClick: () => actions.newTable({ ...ctx, db: ndb }) },
        { type: 'divider' },
        !isMongo && conn && RELATIONAL.includes(conn.type)
          ? { key: 'transferdb', label: '数据传输…', icon: <SwapOutlined />, onClick: () => setTransfer({ connId: node.connId, db: ndb, schema: node.schema }) }
          : null,
        !isMongo && conn && RELATIONAL.includes(conn.type)
          ? {
              key: 'dumpdb',
              label: '导出数据库…',
              icon: <ExportOutlined />,
              // 转储 SQL 文件：可选仅架构 / 仅数据 / 架构+数据（DumpModal）
              onClick: () => setDump({ connId: node.connId, db: ndb, schema: node.schema, title: `导出数据库「${node.name}」` }),
            }
          : null,
        !isMongo && conn && RELATIONAL.includes(conn.type)
          ? { key: 'syncdb', label: '结构同步…', icon: <DiffOutlined />, onClick: () => actions.openSync({ connId: node.connId, db: ndb || '', schema: node.schema || '' }) }
          : null,
        !isMongo && conn && RELATIONAL.includes(conn.type)
          ? { key: 'datasync', label: '数据同步…', icon: <DatabaseOutlined />, onClick: () => actions.openDataSync({ connId: node.connId, db: ndb || '', schema: node.schema || '' }) }
          : null,
        conn && RELATIONAL.includes(conn.type)
          ? {
              key: 'er',
              label: '查看 ER 图',
              icon: <ApartmentOutlined />,
              onClick: () => actions.openEr({ connId: node.connId, db: ndb, schema: node.schema }),
            }
          : null,
        { key: 'copy', label: isMongo ? '复制数据库名' : '复制库名', icon: <CopyOutlined />, onClick: () => copyTextOk('库名', node.name) },
      ];
      if (!isMongo) {
        items.push({
          key: 'dropdb',
          label: '删除数据库',
          danger: true,
          onClick: () =>
            confirmRun(`删除数据库「${node.name}」？其中所有对象将丢失！`, () => dbApi(node.connId, 'dropDatabase', { db: node.name })),
        });
      }
      items.push({ key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNode(node.key, node) });
      return items;
    }
    if (node.type === 'cat') {
      const isMongo = conn && conn.type === 'mongo';
      // 表下的结构分组（字段/索引/外键/唯一键/检查/触发器）：查询上下文归到所属表
      if (TSTRUCT_KINDS.includes(node.kind)) {
        const items = [];
        // 分组专属「新建」：结构五类打开表设计器并定位到对应分区追加空白行；触发器是代码对象走 SQL 模板；视图列只读不提供
        const NEW_LABEL = { fields: '新建字段', indexes: '新建索引', fkeys: '新建外键', uniques: '新建唯一键', checks: '新建检查' }[node.kind];
        const NEW_KIND = { fields: 'col', indexes: 'idx', fkeys: 'fk', uniques: 'uq', checks: 'ck' }[node.kind];
        if (NEW_LABEL && node.table && !node.srcView) {
          items.push({
            key: 'ns',
            label: NEW_LABEL,
            icon: <PlusOutlined />,
            onClick: () => actions.designTable({ connId: node.connId, db: node.db, schema: node.schema, table: node.table, focus: { kind: NEW_KIND, create: true, ts: Date.now() } }),
          });
        }
        if (node.kind === 'triggers' && node.table) {
          items.push({
            key: 'ntg',
            label: '新建触发器',
            icon: <PlusOutlined />,
            onClick: () => actions.openObjEdit({ connId: node.connId, db: node.db, schema: node.schema, kind: 'trigger', isNew: true, refreshKey: node.key }),
          });
        }
        items.push({ key: 'q', label: '新建查询', icon: <SearchOutlined />, onClick: () => actions.newQuery({ connId: node.connId, db: node.db, schema: node.schema, table: node.table }) });
        items.push({ key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNode(node.key, node) });
        return items;
      }
      const newItems = [];
      if (isMongo) {
        newItems.push({
          key: 'nt',
          label: '新建集合…',
          icon: <PlusOutlined />,
          onClick: () =>
            setPrompt({
              title: '新建集合',
              label: '集合名',
              onOk: (v) =>
                dbApi(node.connId, 'createTable', { db: node.db, name: v.trim() })
                  .then(() => { message.success('集合已创建'); refreshNode(node.key, node); })
                  .catch((e) => message.error(e.message)),
            }),
        });
      } else if (node.kind === 'model') {
        // 模型：保存当前上下文全部表为 ER 模型（应用层 models.json，非数据库对象）
        newItems.push({
          key: 'nm',
          label: '新建模型…',
          icon: <PlusOutlined />,
          onClick: () =>
            setPrompt({
              title: '新建模型',
              label: '模型名（保存当前库全部表为 ER 模型）',
              onOk: (v) =>
                dbApi(node.connId, 'tables', { db: node.db, schema: node.schema })
                  .then((ts) => modelApi.save({ name: v.trim(), connId: node.connId, db: node.db, schema: node.schema, tables: ts }))
                  .then(() => { message.success('模型已创建'); refreshNode(node.key, node); })
                  .catch((e) => message.error(e.message)),
            }),
        });
      } else if (node.kind === 'recyclebin') {
        newItems.push({
          key: 'emptyrb',
          label: '清空回收站（PURGE）',
          danger: true,
          onClick: () => confirmRun('清空回收站？所有已删除对象将无法还原。', () => dbApi(node.connId, 'recycleEmpty')),
        });
      } else if (node.kind === 'table') {
        newItems.push({ key: 'nt', label: '新建表', icon: <PlusOutlined />, onClick: () => actions.newTable({ connId: node.connId, db: node.db, schema: node.schema }) });
        if (conn && RELATIONAL.includes(conn.type)) {
          newItems.push({ key: 'transferdb', label: '数据传输…', icon: <SwapOutlined />, onClick: () => setTransfer({ connId: node.connId, db: node.db, schema: node.schema }) });
          // sqlite 树没有库节点：表分类节点即库级导出入口
          newItems.push({
            key: 'dumpdb',
            label: '导出数据库…',
            icon: <ExportOutlined />,
            onClick: () => setDump({ connId: node.connId, db: node.db, schema: node.schema, title: `导出数据库「${node.db || node.schema || (conn && conn.name) || ''}」` }),
          });
          newItems.push({ key: 'syncdb', label: '结构同步…', icon: <DiffOutlined />, onClick: () => actions.openSync({ connId: node.connId, db: node.db || '', schema: node.schema || '' }) });
          newItems.push({ key: 'datasync', label: '数据同步…', icon: <DatabaseOutlined />, onClick: () => actions.openDataSync({ connId: node.connId, db: node.db || '', schema: node.schema || '' }) });
          newItems.push({ key: 'impw', label: '导入向导…', icon: <ImportOutlined />, onClick: () => actions.openImport({ connId: node.connId, db: node.db, schema: node.schema }) });
          newItems.push({
            key: 'er',
            label: '查看 ER 图',
            icon: <ApartmentOutlined />,
            onClick: () => actions.openEr({ connId: node.connId, db: node.db || (node.type === 'db' ? node.name : undefined), schema: node.schema }),
          });
        }
      } else if (NEWABLE_KINDS.includes(node.kind)) {
        // 视图/函数/存储过程/触发器/事件/序列/同义词/数据库链接/类型/包 → SQL 编辑器模板
        newItems.push({
          key: 'no',
          label: `新建${KIND_CN[node.kind]}`,
          icon: <PlusOutlined />,
          onClick: () =>
            actions.openObjEdit({ connId: node.connId, db: node.db, schema: node.schema, kind: node.kind, isNew: true, refreshKey: node.key }),
        });
        if (node.kind === 'view') {
          newItems.push({
            key: 'nvd',
            label: '新建视图（设计）',
            icon: <SettingOutlined />,
            onClick: () => actions.newView({ connId: node.connId, db: node.db, schema: node.schema, refreshKey: node.key }),
          });
        }
      }
      newItems.push({ key: 'q', label: '新建查询', icon: <SearchOutlined />, onClick: () => actions.newQuery({ connId: node.connId, db: node.db, schema: node.schema }) });
      newItems.push({ key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNode(node.key, node) });
      return newItems;
    }
    if (node.type === 'model') {
      return [
        { key: 'open', label: '打开 ER 图', icon: <ApartmentOutlined />, onClick: () => actions.openEr({ connId: node.connId, db: node.db, schema: node.schema, tables: node.tables, modelName: node.name }) },
        {
          key: 'ren',
          label: '重命名…',
          icon: <EditOutlined />,
          onClick: () =>
            setPrompt({
              title: '重命名模型',
              label: '新模型名',
              value: node.name,
              onOk: (v) =>
                modelApi
                  .save({ id: node.modelId, name: v.trim() })
                  .then(() => { message.success('已重命名'); refreshNodeOf(node); })
                  .catch((e) => message.error(e.message)),
            }),
        },
        { key: 'copyname', label: '复制模型名', icon: <CopyOutlined />, onClick: () => copyTextOk('模型名', node.name) },
        { type: 'divider' },
        {
          key: 'del',
          label: '删除模型',
          danger: true,
          onClick: () =>
            confirmRun(`删除模型「${node.name}」？（仅删除保存的模型，不影响数据库）`, () =>
              modelApi.remove(node.modelId).then((r) => {
                if (r && r.ok === false) throw new Error(r.error || '删除失败');
              }).then(() => refreshNodeOf(node))),
        },
        { key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNodeOf(node) },
      ];
    }
    if (node.type === 'recycle') {
      return [
        {
          key: 'restore',
          label: '还原（FLASHBACK）',
          icon: <UndoOutlined />,
          onClick: () => confirmRun(`还原「${node.name}」到删除前的状态？`, () => dbApi(node.connId, 'recycleRestore', { bin: node.bin }).then(() => refreshNodeOf(node))),
        },
        {
          key: 'info',
          label: '查看信息',
          icon: <InfoCircleOutlined />,
          onClick: () => actions.openDdl({ connId: node.connId, kind: 'recycle', name: node.bin, original: node.name, rtype: node.rtype, droptime: node.droptime, refreshKey: parentKeyOfNode(node) }),
        },
        { key: 'copyname', label: '复制原始名', icon: <CopyOutlined />, onClick: () => copyTextOk('原始名', node.name) },
        { type: 'divider' },
        {
          key: 'purge',
          label: '彻底删除',
          danger: true,
          onClick: () => confirmRun(`彻底删除「${node.name}」？删除后将无法还原。`, () => dbApi(node.connId, 'recyclePurge', { bin: node.bin }).then(() => refreshNodeOf(node))),
        },
        { key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNodeOf(node) },
      ];
    }
    if (OBJ_KINDS.includes(node.type)) {
      const kind = node.type;
      return [
        { key: 'open', label: '查看源码', icon: <CodeOutlined />, onClick: () => actions.openDdl({ connId: node.connId, db: node.db, schema: node.schema, kind, name: node.name, table: node.table, refreshKey: parentKeyOf() }) },
        NEWABLE_KINDS.includes(kind)
          ? {
              key: 'edit',
              label: `编辑${KIND_CN[kind] || ''}`,
              icon: <EditOutlined />,
              onClick: () => actions.openObjEdit({ connId: node.connId, db: node.db, schema: node.schema, kind, name: node.name, refreshKey: parentKeyOf() }),
            }
          : null,
        {
          key: 'copy',
          label: '复制源码',
          icon: <CopyOutlined />,
          onClick: () =>
            dbApi(node.connId, 'objectDdl', { db: node.db, schema: node.schema, kind, name: node.name, table: node.table })
              .then((sql) => copyText(sql).then(() => message.success('已复制')))
              .catch((e) => message.error(e.message)),
        },
        { key: 'copyname', label: '复制名称', icon: <CopyOutlined />, onClick: () => copyTextOk('名称', node.name) },
        { type: 'divider' },
        kind !== 'tablespace'
          ? {
              key: 'drop',
              label: '删除',
              danger: true,
              onClick: () =>
                confirmRun(`删除${KIND_CN[kind] || ''}「${node.name}」？`, () =>
                  dbApi(node.connId, 'dropObject', { db: node.db, schema: node.schema, kind, name: node.name, table: node.table }).then(() => refreshNodeOf(node))),
            }
          : null,
        { key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNodeOf(node) },
      ].filter(Boolean);
    }
    // 字段（表/视图展开出来的列节点）：表的列可「编辑字段」定位设计器；视图列仅复制类操作
    if (node.type === 'column') {
      return [
        !node.isView && node.table
          ? {
              key: 'edit',
              label: '编辑字段',
              icon: <EditOutlined />,
              onClick: () => actions.designTable({ connId: node.connId, db: node.db, schema: node.schema, table: node.table, focus: { kind: 'col', name: node.name, ts: Date.now() } }),
            }
          : null,
        { key: 'copyname', label: '复制字段名', icon: <CopyOutlined />, onClick: () => copyTextOk('字段名', node.name) },
        node.dt ? { key: 'copydt', label: '复制类型', icon: <CopyOutlined />, onClick: () => copyTextOk('类型', node.dt) } : null,
        { key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNodeOf(node) },
      ].filter(Boolean);
    }
    // 索引/外键/唯一键/检查/触发器明细行
    if (TSTRUCT_LEAF[node.type]) {
      const cn = TSTRUCT_CN[node.type];
      // 明细行「编辑」：结构类打开表设计器并定位该行；触发器查看源码
      const editLeaf =
        node.type === 'tg'
          ? { key: 'src', label: '查看源码', icon: <CodeOutlined />, onClick: () => actions.openDdl({ connId: node.connId, db: node.db, schema: node.schema, kind: 'trigger', name: node.name, table: node.table, refreshKey: parentKeyOf() }) }
          : { key: 'edit', label: `编辑${cn}`, icon: <EditOutlined />, onClick: () => actions.designTable({ connId: node.connId, db: node.db, schema: node.schema, table: node.table, focus: { kind: node.type, name: node.name, ts: Date.now() } }) };
      // sqlite 外键/检查需重建表、匿名检查（合成名）无法按名定位：不提供删除
      const droppable = !node.anon && !(conn && conn.type === 'sqlite' && (node.type === 'fk' || node.type === 'ck'));
      return [
        editLeaf,
        { key: 'copyname', label: '复制名称', icon: <CopyOutlined />, onClick: () => copyTextOk('名称', node.name) },
        droppable
          ? {
              key: 'drop',
              label: `删除${cn}`,
              icon: <DeleteOutlined />,
              danger: true,
              onClick: () =>
                confirmRun(`删除${cn}「${node.name}」？`, () =>
                  dbApi(node.connId, 'dropStruct', { db: node.db, schema: node.schema, table: node.table, kind: TSTRUCT_DROP[node.type], name: node.name }).then(() => refreshNodeOf(node))),
            }
          : null,
        { key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNodeOf(node) },
      ].filter(Boolean);
    }
    // 表 / 视图
    const isTable = node.type === 'table';
    const canTransfer = conn && RELATIONAL.includes(conn.type);
    // 限定名（SELECT/INSERT 语句用）：MySQL 带库名前缀，PG/MSSQL/Oracle 带 schema
    const qual =
      conn && (conn.type === 'mysql' || conn.type === 'mariadb') && node.db
        ? `${node.db}.${node.name}`
        : node.schema
          ? `${node.schema}.${node.name}`
          : node.name;
    // 导出 SQL 转储：经 DumpModal 选择内容（仅架构/仅数据/架构+数据），主进程逐表写出
    const openDump = () =>
      setDump({ connId: node.connId, db: node.db, schema: node.schema, tables: [node.name], lockTables: true, title: `导出表「${node.name}」` });
    const showCount = () =>
      dbApi(node.connId, 'page', { db: node.db, schema: node.schema, table: node.name, pageNo: 1, pageSize: 1 })
        .then((r) => Modal.info({ title: '查看行数', content: `「${node.name}」共 ${r.total} 行` }))
        .catch((e) => message.error(e.message));
    const copyInsert = () =>
      dbApi(node.connId, 'columns', { db: node.db, schema: node.schema, table: node.name })
        .then((cols) => {
          const names = cols.map((c) => c.name);
          const sql = `INSERT INTO ${qual}\n  (${names.join(', ')})\nVALUES\n  (${names.map(() => '?').join(', ')});`;
          return copyTextOk('INSERT 语句', sql);
        })
        .catch((e) => message.error(e.message));
    return [
      { key: 'open', label: '打开表', icon: <TableOutlined />, onClick: () => actions.openTable(ctx) },
      isTable && !(conn && conn.type === 'mongo') ? { key: 'design', label: '设计表', icon: <SettingOutlined />, onClick: () => actions.designTable(ctx) } : null,
      !isTable
        ? {
            key: 'designview',
            label: '设计视图',
            icon: <SettingOutlined />,
            onClick: () => actions.designView({ connId: node.connId, db: node.db, schema: node.schema, name: node.name, refreshKey: parentKeyOf() }),
          }
        : null,
      !isTable
        ? {
            key: 'editview',
            label: '编辑视图',
            icon: <EditOutlined />,
            onClick: () => actions.openObjEdit({ connId: node.connId, db: node.db, schema: node.schema, kind: 'view', name: node.name, refreshKey: parentKeyOf() }),
          }
        : null,
      { key: 'q', label: '新建查询', icon: <SearchOutlined />, onClick: () => actions.newQuery(ctx) },
      { type: 'divider' },
      { key: 'copyname', label: isTable ? '复制表名' : '复制视图名', icon: <CopyOutlined />, onClick: () => copyTextOk(isTable ? '表名' : '视图名', node.name) },
      {
        key: 'ddl',
        label: '复制 DDL',
        icon: <CopyOutlined />,
        onClick: () =>
          dbApi(node.connId, 'ddl', { db: node.db, schema: node.schema, table: node.name })
            .then((sql) => copyText(sql).then(() => message.success('DDL 已复制')))
            .catch((e) => message.error(e.message)),
      },
      { key: 'copysel', label: '复制 SELECT 语句', icon: <CopyOutlined />, onClick: () => copyTextOk('SELECT 语句', `SELECT * FROM ${qual};`) },
      isTable ? { key: 'copyins', label: '复制 INSERT 模板', icon: <CopyOutlined />, onClick: copyInsert } : null,
      { key: 'count', label: '查看行数', icon: <NumberOutlined />, onClick: showCount },
      isTable && canTransfer
        ? {
            key: 'expdata',
            label: '导出数据…',
            icon: <ExportOutlined />,
            onClick: () =>
              setExpState({
                title: `导出「${node.name}」数据`,
                name: node.name,
                table: qual,
                fetchRows: async () => {
                  const PS = 1000;
                  const all = [];
                  let p = 1;
                  let cols = null;
                  for (;;) {
                    const r = await dbApi(node.connId, 'page', { db: node.db, schema: node.schema, table: node.name, pageNo: p, pageSize: PS });
                    cols = r.columns.map((c) => c.name);
                    all.push(...r.rows);
                    if (!r.rows.length || all.length >= r.total) break;
                    p += 1;
                  }
                  return { columns: cols, rows: all };
                },
                hint: '按 1000 行/批从数据库抓取全表数据后导出。',
              }),
          }
        : null,
      canTransfer ? { key: 'dump', label: '导出 SQL 转储…', icon: <ExportOutlined />, onClick: openDump } : null,
      { type: 'divider' },
      isTable && canTransfer ? { key: 'csv', label: '导入 CSV…', icon: <ImportOutlined />, onClick: () => importCsv(ctx) } : null,
      isTable && canTransfer ? { key: 'transfer', label: '数据传输…', icon: <SwapOutlined />, onClick: () => setTransfer(ctx) } : null,
      isTable
        ? {
            key: 'ren',
            label: '重命名…',
            icon: <EditOutlined />,
            onClick: () =>
              setPrompt({
                title: '重命名表',
                label: conn && conn.type === 'mongo' ? '新集合名' : '新表名',
                value: node.name,
                onOk: (v) =>
                  dbApi(node.connId, 'renameTable', { db: node.db, schema: node.schema, table: node.name, newName: v.trim() })
                    .then(() => { message.success('已重命名'); refreshNodeOf(node); })
                    .catch((e) => message.error(e.message)),
              }),
          }
        : null,
      isTable
        ? {
            key: 'trunc',
            label: '清空表',
            danger: true,
            onClick: () =>
              confirmRun(`清空表「${node.name}」的所有数据？`, () => dbApi(node.connId, 'truncateTable', { db: node.db, schema: node.schema, table: node.name })),
          }
        : null,
      {
        key: 'drop',
        label: isTable ? '删除表' : '删除视图',
        danger: true,
        onClick: () => confirmRun(`删除${isTable ? '表' : '视图'}「${node.name}」？`, () => dbApi(node.connId, 'dropTable', { db: node.db, schema: node.schema, table: node.name }).then(() => refreshNodeOf(node))),
      },
      { key: 'rf', label: '刷新', icon: <ReloadOutlined />, onClick: () => refreshNodeOf(node) },
    ].filter(Boolean);
  }

  async function importCsv(ctx) {
    const file = await pickFile({
      title: '选择要导入的 CSV 文件（首行为表头，列名相同的自动映射）',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    });
    if (!file) return;
    Modal.confirm({
      title: `导入 CSV 到表「${ctx.table}」？`,
      content: `文件：${file}\n首行列名与表列名相同的自动导入；空单元格置 NULL。`,
      okText: '开始导入',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await dbApi(ctx.connId, 'importCsv', { db: ctx.db, schema: ctx.schema, table: ctx.table, file });
          message.success(`导入完成：${r.inserted} 行`);
        } catch (e) {
          message.error(`导入失败：${e.message}`);
        }
      },
    });
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span>连接</span>
        <Space size={2}>
          <Button size="small" type="text" icon={<PlusOutlined />} title="新建连接" onClick={actions.newConn} />
          <Button size="small" type="text" icon={<ReloadOutlined />} title="刷新全部" onClick={() => actions.refreshTree()} />
          <Button size="small" type="text" icon={<SaveOutlined />} title="查询列表（已保存）" onClick={actions.openQueries} />
          <Button size="small" type="text" icon={<ScheduleOutlined />} title="备份计划" onClick={actions.openBackups} />
          <Button
            size="small"
            type="text"
            icon={dark ? <MoonOutlined /> : <SunOutlined />}
            title={dark ? '切换浅色' : '切换深色'}
            onClick={onToggleDark}
          />
        </Space>
      </div>
      <div className="sidebar-search">
        <Input size="small" allowClear placeholder="筛选对象树（表/视图/字段…）" value={search} onChange={(e) => setSearch(e.target.value)} prefix={<SearchOutlined style={{ color: '#bbb' }} />} />
      </div>
      <div
        className="tree-wrap"
        onDoubleClick={(e) => {
          // 双击整行任一位置（箭头/图标/文字/空白）都触发
          const row = e.target.closest && e.target.closest('.ant-tree-treenode');
          if (!row) { console.log('DH-DBL no-row'); return; }
          const el = row.querySelector('.node-title');
          const nd = el && titleEls.current.get(el);
          if (!nd) { console.log('DH-DBL miss ' + (el ? el.textContent : 'no-title')); return; }
          console.log('DH-DBL ' + nd.type + ' ' + nd.name);
          handleDblClick(nd, connOf(nd.connId));
        }}
        onContextMenu={(e) => {
          // 右键整行任一位置都弹菜单（rc-tree 自带的 onRightClick 只覆盖标题区，不含箭头/缩进）
          const row = e.target.closest && e.target.closest('.ant-tree-treenode');
          if (!row) { console.log('DH-CTX-MISS no-row'); return; }
          const el = row.querySelector('.node-title');
          const nd = el && titleEls.current.get(el);
          if (!nd) { console.log('DH-CTX-MISS no-node'); return; }
          console.log('DH-CTX ' + nd.type + ' ' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, node: nd });
        }}
      >
        {conns.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无连接" style={{ marginTop: 40 }}>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={actions.newConn}>
              新建连接
            </Button>
          </Empty>
        ) : (
          <Tree
            showIcon
            blockNode
            motion={false}
            expandedKeys={search.trim() ? Array.from(new Set([...expanded, ...treeView.keys])) : expanded}
            onExpand={(keys, info) => {
              setExpanded(keys);
              const nd = info.node && info.node.node;
              if (!nd || !info.expanded) return;
              expandLoad(info.node.key, nd);
            }}
            onSelect={(_keys, info) => {
              const nd = info && info.node && info.node.node;
              if (onTreeSel) onTreeSel(selCtxOf(nd));
            }}
            treeData={treeView.data}
          />
        )}
      </div>
      {/* 右键菜单：固定定位 + antd Menu 直渲染（不经 Dropdown 的锚点对齐——0 尺寸锚点会让 rc-trigger 卡在屏外预对齐位，菜单不可见）。
          FloatMenu 量实际尺寸后钳制到窗口内，靠边/靠底不再被截断 */}
      {ctxMenu && (
        <FloatMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={menuItems(ctxMenu.node, connOf(ctxMenu.node.connId))}
          onClose={() => setCtxMenu(null)}
        />
      )}
      <PromptModal state={prompt} onClose={() => setPrompt(null)} />
      <TransferModal state={transfer} conns={conns} onClose={() => setTransfer(null)} />
      <DumpModal state={dump} conns={conns} onClose={() => setDump(null)} />
      <ExportModal state={expState} onClose={() => setExpState(null)} />
    </div>
  );
}

function PromptModal({ state, onClose }) {
  const [v, setV] = useState('');
  useEffect(() => {
    setV(state ? state.value || '' : '');
  }, [state]);
  if (!state) return null;
  return (
    <Modal
      open
      title={state.title}
      onCancel={onClose}
      onOk={() => {
        if (v.trim()) state.onOk(v);
        onClose();
      }}
      okText="确定"
      cancelText="取消"
      destroyOnClose
    >
      <Input placeholder={state.label} value={v} onChange={(e) => setV(e.target.value)} onPressEnter={() => { if (v.trim()) state.onOk(v); onClose(); }} />
    </Modal>
  );
}

// 数据传输向导：源（固定为入口连接/库）表多选 → 目标连接/库/schema → 内容与已存在策略 → 逐表进度日志
function TransferModal({ state, conns, onClose }) {
  const [dstId, setDstId] = useState('');
  const [dstDb, setDstDb] = useState('');
  const [dstSchema, setDstSchema] = useState('');
  const [tables, setTables] = useState(null); // null=加载中；[{name, checked}]
  const [content, setContent] = useState('copy'); // copy=结构+数据 / structure=仅结构
  const [exists, setExists] = useState('drop'); // drop / skip / error
  const [contOnErr, setContOnErr] = useState(true);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const logRef = useRef(null);
  const { connId, db, schema, table } = state || {};
  const srcConn = conns.find((c) => c.id === connId);

  useEffect(() => {
    if (!state) return undefined;
    setDstId('');
    setDstDb('');
    setDstSchema('');
    setTables(null);
    setLogs([]);
    setBusy(false);
    setDone(false);
    setContent('copy');
    setExists('drop');
    setContOnErr(true);
    let alive = true;
    dbApi(connId, 'tables', { db, schema })
      .then((list) => {
        if (alive) setTables(list.map((n) => ({ name: n, checked: n === table })));
      })
      .catch((e) => {
        if (alive) setTables([]);
        setLogs((p) => [...p, { k: 'err', t: '读取表列表失败：' + e.message }]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  if (!state) return null;
  const dstConn = conns.find((c) => c.id === dstId);
  const needSchema = dstConn && (dstConn.type === 'postgres' || dstConn.type === 'mssql' || dstConn.type === 'oracle');
  const needDb = dstConn && dstConn.type !== 'sqlite';
  const selected = (tables || []).filter((t) => t.checked);
  const allChecked = !!tables && !!tables.length && tables.every((t) => t.checked);
  const toggle = (name, checked) => setTables((p) => (p || []).map((t) => (t.name === name ? { ...t, checked } : t)));
  const toggleAll = (checked) => setTables((p) => (p || []).map((t) => ({ ...t, checked })));
  const addLog = (k, t) => setLogs((p) => [...p, { k, t }]);
  const canRun = !busy && !!selected.length && !!dstId && (!needDb || !!dstDb.trim());
  const run = async () => {
    setBusy(true);
    setDone(false);
    setLogs([{ k: 'info', t: `开始传输：${selected.length} 张表（${content === 'copy' ? '结构+数据' : '仅结构'}；目标已存在=${exists === 'drop' ? '删除重建' : exists === 'skip' ? '跳过' : '报错'}）` }]);
    let okN = 0;
    let skipN = 0;
    let errN = 0;
    for (let i = 0; i < selected.length; i++) {
      const t = selected[i].name;
      try {
        const r = await dbTransfer({ srcId: connId, table: t, schema, db, dstId, dstDb: dstDb.trim(), dstSchema: dstSchema.trim(), content, exists });
        if (r.skipped) {
          skipN += 1;
          addLog('skip', `[${i + 1}/${selected.length}] ${t}：跳过（目标已存在）`);
        } else if (r.structureOnly) {
          okN += 1;
          addLog('ok', `[${i + 1}/${selected.length}] ${t}：结构已创建`);
        } else {
          okN += 1;
          addLog('ok', `[${i + 1}/${selected.length}] ${t}：完成，写入 ${r.copied} 行`);
        }
      } catch (e) {
        errN += 1;
        addLog('err', `[${i + 1}/${selected.length}] ${t}：失败：${e.message}`);
        if (!contOnErr) {
          addLog('err', `遇到错误，已停止（未处理：${selected.slice(i + 1).map((x) => x.name).join('、') || '无'}）`);
          break;
        }
      }
    }
    addLog(errN ? 'err' : 'ok', `结束：成功 ${okN}、跳过 ${skipN}、失败 ${errN}`);
    setBusy(false);
    setDone(true);
    if (errN === 0) message.success(`传输完成：成功 ${okN}${skipN ? `、跳过 ${skipN}` : ''}`);
  };
  return (
    <Modal
      open
      width={700}
      title="数据传输"
      onCancel={() => {
        if (!busy) onClose();
      }}
      okText={busy ? '传输中…' : '开始传输'}
      cancelText={done ? '关闭' : '取消'}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      okButtonProps={{ disabled: !canRun }}
      onOk={run}
    >
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: '1 1 52%' }} data-dh-tr="src">
          <div style={{ marginBottom: 4 }}>
            源：<b>{srcConn ? srcConn.name : ''}</b> · {db || schema || '默认'}
          </div>
          <div className="dh-tr-list">
            {tables === null ? (
              <div style={{ padding: 12, color: '#999' }}>表列表加载中…</div>
            ) : !tables.length ? (
              <div style={{ padding: 12, color: '#999' }}>无表</div>
            ) : (
              tables.map((t) => (
                <div key={t.name} className="dh-tr-row" data-dh-tr-name={t.name}>
                  <Checkbox checked={t.checked} onChange={(e) => toggle(t.name, e.target.checked)}>
                    {t.name}
                  </Checkbox>
                </div>
              ))
            )}
          </div>
          <div style={{ marginTop: 4 }}>
            <Checkbox checked={allChecked} disabled={!tables || !tables.length} onChange={(e) => toggleAll(e.target.checked)} data-dh-tr="all">
              全选
            </Checkbox>
            <span style={{ marginLeft: 8, color: '#999', fontSize: 12 }}>已选 {selected.length}/{tables ? tables.length : 0}</span>
          </div>
        </div>
        <div style={{ flex: '1 1 48%' }}>
          <div style={{ marginBottom: 4 }}>目标连接：</div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择目标连接"
            value={dstId || undefined}
            onChange={setDstId}
            options={conns
              .filter((c) => c.id !== connId && RELATIONAL.includes(c.type))
              .map((c) => ({ value: c.id, label: `${c.name}（${TYPE_LABEL[c.type]}）` }))}
          />
          {needDb && (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 4 }}>目标数据库{dstConn.type === 'postgres' ? '（可选，默认连接库）' : ''}：</div>
              <Input value={dstDb} onChange={(e) => setDstDb(e.target.value)} placeholder={dstConn.type === 'postgres' ? '留空=连接默认库' : '目标数据库名'} />
            </div>
          )}
          {needSchema && (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 4 }}>目标 schema（{dstConn.type === 'postgres' ? '默认 public' : dstConn.type === 'oracle' ? '必填（=用户名，大写）' : '默认 dbo'}）：</div>
              <Input value={dstSchema} onChange={(e) => setDstSchema(e.target.value)} placeholder={dstConn.type === 'postgres' ? 'public' : dstConn.type === 'oracle' ? '例如 SCOTT' : 'dbo'} />
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <div style={{ marginBottom: 4 }}>传输内容：</div>
            <Radio.Group value={content} onChange={(e) => setContent(e.target.value)} data-dh-tr="content">
              <Radio value="copy">结构 + 数据</Radio>
              <Radio value="structure">仅结构</Radio>
            </Radio.Group>
          </div>
          <div style={{ marginTop: 6 }}>
            <div style={{ marginBottom: 4 }}>目标已存在同名表：</div>
            <Radio.Group value={exists} onChange={(e) => setExists(e.target.value)} data-dh-tr="exists">
              <Radio value="drop">删除重建</Radio>
              <Radio value="skip">跳过</Radio>
              <Radio value="error">报错</Radio>
            </Radio.Group>
          </div>
          <div style={{ marginTop: 6 }}>
            <Checkbox checked={contOnErr} onChange={(e) => setContOnErr(e.target.checked)} data-dh-tr="conterr">
              遇到错误时继续
            </Checkbox>
          </div>
        </div>
      </div>
      <div
        ref={logRef}
        className="dh-tr-logs"
        data-dh-tr="logs"
        style={{ marginTop: 10, maxHeight: 170, overflow: 'auto', background: '#fafafa', border: '1px solid #eee', borderRadius: 4, padding: '6px 8px', fontSize: 12, fontFamily: 'Consolas, monospace' }}
      >
        {logs.length ? logs.map((x, i) => (
          <div key={i} data-dh-tr-log={x.k} style={{ color: x.k === 'err' ? '#cf1322' : x.k === 'ok' ? '#389e0d' : x.k === 'skip' ? '#d46b08' : '#555' }}>
            {x.t}
          </div>
        )) : <div style={{ color: '#bbb' }}>执行日志</div>}
      </div>
      <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
        按源结构在目标建表（跨方言自动类型映射；自增列退化为普通整数，索引/外键/视图不同步），数据分批 500 行参数化写入。
      </div>
    </Modal>
  );
}
