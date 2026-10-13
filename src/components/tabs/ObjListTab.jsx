import React, { useEffect, useState } from 'react';
import { Button, Input, Modal, Segmented, Select, Space, Spin, Table, Tag, message } from 'antd';
import {
  DatabaseOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { dbApi, dbOpen } from '../../api';

// 树根层级是 schema 的驱动（对象列表的「库」下拉实际枚举 schema）
const SCHEMA_ROOT = ['postgres', 'oracle'];
// 索引/唯一键同源的驱动（唯一索引直接归「唯一键」组，与设计器页签口径一致）
const IDX_AS_UQ = ['sqlite', 'mysql', 'mariadb'];

// 表行展开的结构面板：字段 / 索引 / 外键 / 唯一键 / 检查 / 触发器（视图只展示字段）
function ObjDetail({ connId, connType, db, schema, table, isView }) {
  const [groups, setGroups] = useState(null); // null=加载中

  useEffect(() => {
    let alive = true;
    const args = { db, schema, table };
    const safe = (p) => p.catch(() => null);
    Promise.all([
      dbApi(connId, 'columns', args),
      safe(dbApi(connId, 'indexes', args)),
      ['postgres', 'mssql'].includes(connType) ? safe(dbApi(connId, 'uniques', args)) : Promise.resolve(null),
      safe(dbApi(connId, 'fkeys', args)),
      safe(dbApi(connId, 'checks', args)),
      safe(dbApi(connId, 'triggers', args)),
    ])
      .then(([cols, idxRes, uqRes, fkRes, ckRes, trigRes]) => {
        if (!alive) return;
        // 与 DesignTab 相同的归一口径：sqlite/mysql 唯一索引归唯一键；PK 后备索引不列
        const idxAll = (idxRes || []).filter((x) => String(x.origin || 'c') !== 'pk');
        const idxList = IDX_AS_UQ.includes(connType) ? idxAll.filter((x) => !x.unique) : idxAll;
        const uqList = IDX_AS_UQ.includes(connType)
          ? idxAll.filter((x) => x.unique).map((x) => ({ name: x.name, columns: x.columns || [] }))
          : (uqRes || []).map((x) => ({ name: x.name, columns: x.columns || [], clustered: !!x.clustered }));
        const g = [
          {
            label: '字段',
            items: (cols || []).map((c) =>
              [
                c.name,
                c.display || c.dataType,
                c.pk ? '主键' : '',
                c.autoInc ? '自增' : '',
                c.nullable ? '' : '非空',
                c.defaultValue == null || c.defaultValue === '' ? '' : `默认 ${c.defaultValue}`,
                c.comment || '',
              ]
                .filter(Boolean)
                .join(' · ')
            ),
          },
        ];
        if (!isView) {
          g.push(
            {
              label: '索引',
              items: idxList.map((x) =>
                [
                  `${x.name}（${(x.columns || []).map((c, i) => c + (String((x.dirs || [])[i] || '').toUpperCase() === 'DESC' ? ' DESC' : '')).join(', ')}）`,
                  x.type ? String(x.type).toUpperCase() : '',
                  x.comment || '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              ),
            },
            {
              label: '外键',
              items: (fkRes || []).map((x) =>
                [
                  `${x.name}：${(x.columns || []).join(', ')} → ${x.refSchema ? x.refSchema + '.' : ''}${x.refTable}(${(x.refColumns || []).join(', ')})`,
                  x.onDelete ? `删除 ${x.onDelete}` : '',
                  x.onUpdate ? `更新 ${x.onUpdate}` : '',
                  x.enabled === false ? '已禁用' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              ),
            },
            {
              label: '唯一键',
              items: uqList.map((x) => `${x.name}（${(x.columns || []).join(', ')}）${x.clustered ? ' · 聚集' : ''}`),
            },
            {
              label: '检查',
              items: (ckRes || []).map((x) => `${x.name ? x.name + '：' : ''}${x.expr}${x.enabled === false ? ' · 已禁用' : ''}`),
            },
            {
              label: '触发器',
              items: (trigRes || []).map((x) =>
                [x.name, x.timing, x.event, x.enabled === false ? '已禁用' : ''].filter(Boolean).join(' · ')
              ),
            }
          );
        }
        setGroups(g);
      })
      .catch((e) => {
        if (alive) setGroups([{ label: '字段', items: [], err: e.message }]);
      });
    return () => {
      alive = false;
    };
  }, [connId, connType, db, schema, table, isView]);

  if (!groups) {
    return (
      <div className="objs-detail" data-dh-detail={table}>
        <Spin size="small" />
      </div>
    );
  }
  return (
    <div className="objs-detail" data-dh-detail={table}>
      {groups.map((g) => (
        <div className="objs-dg" data-dh-dg={g.label} key={g.label}>
          <div className="objs-dg-head">
            {g.label}
            <span className="objs-dg-count">{g.err ? '加载失败' : g.items.length}</span>
          </div>
          <div className="objs-dg-list">
            {g.items.length ? (
              g.items.map((it, i) => (
                <div className="objs-dg-item" key={i} title={it}>
                  {it}
                </div>
              ))
            ) : (
              <div className="objs-dg-empty">{g.err ? g.err : '无'}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// 工具栏「表 / 视图」打开的对象列表页：展示目标库已有的表（或视图）清单。
// 左侧树选中其他库/表时由 App 自动重定向（切换 connId/db/schema，不抢焦点）；
// 表行可展开查看结构（字段/索引/外键/唯一键/检查/触发器）；新建入口保留在页内。
export default function ObjListTab({ connId, connName, connType, db, schema, objKind: kind, active, actions, onStatus, onChanged, onRebind }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dbs, setDbs] = useState(null); // null=未加载；sqlite 单库为 []
  const [search, setSearch] = useState('');
  const [seq, setSeq] = useState(0);
  const [expanded, setExpanded] = useState([]); // 展开的表名（切换目标时收起）
  // mssql 架构筛选（v0927.52）：''=全部架构（默认）；绑定 schema（树选中具体表带下）优先于页内选择
  const [schSel, setSchSel] = useState('');
  const [schemas, setSchemas] = useState(null); // null=未加载

  const scopeIsSchema = SCHEMA_ROOT.includes(connType);
  const scopeValue = scopeIsSchema ? schema || '' : db || '';
  const multiSch = connType === 'mssql';
  const effSchema = multiSch ? schema || schSel || '*' : schema;
  const rowKeyOf = (r) => (multiSch && r.schema ? r.schema + '.' + r.name : r.name);
  const rschOf = (r) => (multiSch ? r.schema || schema || 'dbo' : schema);

  const reload = () => setSeq((s) => s + 1);

  const load = async () => {
    setLoading(true);
    try {
      await dbOpen(connId); // 未打开的连接（工具栏兜底目标）直接补开
      const r = await dbApi(connId, 'objList', { db, schema: effSchema, kind });
      setList(r || []);
    } catch (e) {
      setList([]);
      message.error(`对象列表加载失败：${e.message}`);
      onStatus(`对象列表加载失败：${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, effSchema, kind, seq]);

  // 切换目标（跟随树选择或页内切换）后清空搜索词并收起展开，避免跨库残留
  useEffect(() => {
    setSearch('');
    setExpanded([]);
  }, [connId, db, schema, kind]);

  // 切库/切分类时架构筛选回到「全部」（树重定向改 schema 不在此列——绑定 schema 本就优先）
  useEffect(() => {
    setSchSel('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, kind]);

  // mssql 架构下拉选项（v0927.52）：树的根节点是库不是架构，schema 清单单独拉
  useEffect(() => {
    if (!multiSch) return undefined;
    let alive = true;
    (async () => {
      try {
        await dbOpen(connId);
        const r = await dbApi(connId, 'schemas', { db });
        if (alive) setSchemas(r || []);
      } catch {
        if (alive) setSchemas([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db]);

  // 每次切回本页刷新一次：设计器/树上的新建、删除都能及时反映
  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 目标下拉选项：树的根节点（mysql/mssql=库，pg/oracle=schema；sqlite 根是分类 → 无下拉）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const root = await dbApi(connId, 'treeRoot');
        if (!alive) return;
        setDbs((root || []).filter((n) => n.type === 'db' || n.type === 'schema').map((n) => n.name));
      } catch {
        if (alive) setDbs([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [connId]);

  const filtered = search.trim()
    ? list.filter((x) => String(x.name).toLowerCase().includes(search.trim().toLowerCase()))
    : list;

  const dropOne = (name, rsch) => {
    Modal.confirm({
      title: `删除${kind === 'view' ? '视图' : '表'}「${name}」？`,
      content: '该操作不可恢复。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      transitionName: '',
      maskTransitionName: '',
      onOk: async () => {
        try {
          await dbApi(connId, 'dropTable', { db, schema: rsch, table: name });
          message.success(`已删除 ${name}`);
          onStatus(`已删除${kind === 'view' ? '视图' : '表'} ${name}`);
          onChanged();
          reload();
        } catch (e) {
          message.error('删除失败：' + e.message);
        }
      },
    });
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (n) => (
        <span className="objs-name" style={{ fontFamily: 'Consolas, monospace' }}>
          {n}
        </span>
      ),
    },
    ...(multiSch && effSchema === '*'
      ? [{ title: '架构', dataIndex: 'schema', key: 'schema', width: 110, render: (s) => <span style={{ color: '#888' }}>{s || 'dbo'}</span> }]
      : []),
    { title: '注释', dataIndex: 'comment', key: 'comment', ellipsis: true, render: (c) => c || '-' },
    {
      title: '行数',
      dataIndex: 'rows',
      key: 'rows',
      width: 110,
      align: 'right',
      render: (n) => (n == null ? '-' : Number(n).toLocaleString()),
    },
    {
      title: '操作',
      key: 'ops',
      width: 190,
      render: (_, r) => (
        <Space size={0}>
          <Button size="small" type="text" onClick={() => actions.openTable({ connId, db, schema: rschOf(r), table: r.name })}>
            打开
          </Button>
          <Button
            size="small"
            type="text"
            onClick={() =>
              kind === 'view'
                ? actions.designView({ connId, db, schema: rschOf(r), name: r.name })
                : actions.designTable({ connId, db, schema: rschOf(r), table: r.name })
            }
          >
            设计
          </Button>
          <Button size="small" type="text" onClick={() => actions.openDdl({ connId, db, schema: rschOf(r), kind, name: r.name })}>
            DDL
          </Button>
          <Button size="small" type="text" danger onClick={() => dropOne(r.name, rschOf(r))}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="tab-body" data-dh-objs="1">
      <div className="tab-toolbar">
        <span data-dh-kind>
          <Segmented
            size="small"
            value={kind}
            onChange={(v) => onRebind({ objKind: v })}
            options={[
              { label: '表', value: 'table' },
              { label: '视图', value: 'view' },
            ]}
          />
        </span>
        {dbs === null ? null : dbs.length ? (
          <Select
            size="small"
            className="objs-scope"
            style={{ minWidth: 170 }}
            value={scopeValue || undefined}
            showSearch
            placeholder={scopeIsSchema ? '选择方案' : '选择数据库'}
            onChange={(v) => onRebind(scopeIsSchema ? { schema: v, db: '' } : { db: v, schema: '' })}
            options={dbs.map((n) => ({ label: n, value: n }))}
          />
        ) : (
          <Tag icon={<DatabaseOutlined />} style={{ marginInlineEnd: 0 }}>
            {connName || 'SQLite'}（单文件库）
          </Tag>
        )}
        {multiSch && schemas !== null ? (
          <span data-dh-sch>
            <Select
              size="small"
              style={{ minWidth: 130 }}
              value={schema || schSel}
              showSearch
              placeholder="选择架构"
              onChange={(v) => {
                if (schema) onRebind({ schema: '' });
                setSchSel(v);
              }}
              options={[{ label: '全部架构', value: '' }].concat((schemas || []).map((n) => ({ label: n, value: n })))}
            />
          </span>
        ) : null}
        <Input
          size="small"
          allowClear
          placeholder="搜索名称"
          style={{ width: 170 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="ctx" style={{ marginLeft: 0 }}>
          {connName} · {db || schema || '本库'}{multiSch && effSchema === '*' ? ' · 全部架构' : ''} · {filtered.length} 个{kind === 'view' ? '视图' : '表'}
        </span>
        <span className="toolbar-spacer" />
        <Button size="small" icon={<ReloadOutlined />} data-dh-refresh onClick={reload} title="重新加载列表">
          刷新
        </Button>
        <Button
          size="small"
          type="primary"
          ghost
          icon={<PlusOutlined />}
          data-dh-new
          onClick={() => (kind === 'view' ? actions.newView({ connId, db, schema }) : actions.newTable({ connId, db, schema }))}
        >
          新建{kind === 'view' ? '视图' : '表'}
        </Button>
      </div>
      <div className="grid-area">
        <Table
          size="small"
          rowKey={rowKeyOf}
          loading={loading}
          columns={columns}
          dataSource={filtered}
          onRow={(r) => ({
            onDoubleClick: () => actions.openTable({ connId, db, schema: rschOf(r), table: r.name }),
          })}
          expandable={{
            expandedRowKeys: expanded,
            onExpand: (ex, r) => setExpanded((prev) => (ex ? [...prev, rowKeyOf(r)] : prev.filter((x) => x !== rowKeyOf(r)))),
            expandedRowRender: (r) => (
              <ObjDetail connId={connId} connType={connType} db={db} schema={rschOf(r)} table={r.name} isView={kind === 'view'} />
            ),
          }}
          pagination={{ pageSize: 100, size: 'small', showSizeChanger: false, showTotal: (t) => `共 ${t} 个` }}
        />
      </div>
    </div>
  );
}
