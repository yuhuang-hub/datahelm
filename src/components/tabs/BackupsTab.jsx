import React, { useEffect, useState } from 'react';
import { Button, Input, Modal, Select, Space, Switch, Table, message } from 'antd';
import { CaretRightOutlined, FolderOpenOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { backupApi, pickDir, openPath } from '../../api';

const TYPE_LABEL = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite', mssql: 'SQL Server', oracle: 'Oracle' };
const RELATIONAL = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mssql', 'oracle'];

function scheduleText(sc) {
  return sc.mode === 'interval' ? `每 ${sc.minutes} 分钟` : `每天 ${sc.time}`;
}

// 备份自动化：SQL 导出计划（主进程 30s 轮询调度）；还原走「运行 SQL 文件」页签
export default function BackupsTab({ conns, onStatus, onRestore }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [running, setRunning] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setRows(await backupApi.list());
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const runOne = async (sc) => {
    setRunning(sc.id);
    try {
      const r = await backupApi.run(sc.id);
      message.success(`备份完成：${r.objects} 个对象 → ${r.file}`);
      onStatus(`备份完成：${sc.name}（${r.objects} 个对象）`);
      load();
    } catch (e) {
      message.error('备份失败：' + e.message);
      load();
    } finally {
      setRunning('');
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '连接 / 数据库',
      key: 'target',
      render: (_, r) => `${r.connName || r.connId}${r.db ? ' / ' + r.db : ''}${r.schema ? ' / ' + r.schema : ''}`,
    },
    { title: '对象', key: 'tables', render: (_, r) => (r.tables && r.tables.length ? r.tables.join(', ') : '全部') },
    { title: '计划', key: 'sch', render: (_, r) => scheduleText(r) },
    {
      title: '启用',
      key: 'enabled',
      width: 70,
      render: (_, r) => <Switch size="small" checked={r.enabled} onChange={(v) => backupApi.toggle(r.id, v).then(load)} />,
    },
    {
      title: '上次结果',
      key: 'last',
      render: (_, r) =>
        r.lastRunAt ? (
          <span>
            {new Date(r.lastRunAt).toLocaleString('zh-CN', { hour12: false })} · {r.lastStatus}
          </span>
        ) : (
          <span style={{ color: '#999' }}>从未运行</span>
        ),
    },
    {
      title: '操作',
      key: 'op',
      width: 240,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type="primary" icon={<CaretRightOutlined />} loading={running === r.id} onClick={() => runOne(r)}>
            立即备份
          </Button>
          {r.lastFile ? (
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => openPath(r.lastFile)} title={r.lastFile}>
              文件
            </Button>
          ) : null}
          {r.lastFile ? (
            <Button size="small" icon={<PlayCircleOutlined />} title={r.lastFile} onClick={() => onRestore && onRestore({ connId: r.connId, db: r.db, schema: r.schema, file: r.lastFile })}>
              还原
            </Button>
          ) : null}
          <Button size="small" onClick={() => { setEditing(r); setEditOpen(true); }}>
            编辑
          </Button>
          <Button
            size="small"
            danger
            onClick={() =>
              Modal.confirm({
                title: `删除备份计划「${r.name}」？`,
                okText: '删除',
                okType: 'danger',
                cancelText: '取消',
                onOk: async () => {
                  const res = await backupApi.remove(r.id);
                  if (res && res.ok === false) {
                    message.error('删除失败：' + (res.error || '未知错误'));
                  }
                  load();
                },
              })
            }
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setEditOpen(true); }}>
          新建备份计划
        </Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新
        </Button>
        <Button size="small" icon={<PlayCircleOutlined />} onClick={() => onRestore && onRestore()} title="把备份 .sql 文件执行回数据库（运行 SQL 文件）">
          还原备份
        </Button>
        <span className="ctx">备份为 SQL 文件（CREATE + INSERT）；计划由主进程每 30 秒检查一次</span>
      </div>
      <div className="grid-area">
        <Table size="small" rowKey="id" columns={columns} dataSource={rows} pagination={false} loading={loading} />
      </div>
      <BackupEditModal
        open={editOpen}
        conns={conns}
        record={editing}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          load();
        }}
      />
    </div>
  );
}

function BackupEditModal({ open, conns, record, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [connId, setConnId] = useState('');
  const [dbs, setDbs] = useState([]);
  const [db, setDb] = useState('');
  const [schema, setSchema] = useState('');
  const [tables, setTables] = useState('');
  const [dir, setDir] = useState('');
  const [mode, setMode] = useState('daily');
  const [time, setTime] = useState('03:00');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(record ? record.name : '备份计划');
      setConnId(record ? record.connId : '');
      setDb(record ? record.db : '');
      setSchema(record ? record.schema || '' : '');
      setTables(record && record.tables ? record.tables.join(', ') : '');
      setDir(record ? record.dir : '');
      setMode(record ? record.mode : 'daily');
      setTime(record ? record.time : '03:00');
      setMinutes(record ? record.minutes : 60);
      setDbs([]);
      if (!record) backupApi.defaultDir().then(setDir);
    }
  }, [open, record]);

  const pickConn = async (id) => {
    setConnId(id);
    setDb('');
    setSchema('');
    setDbs([]);
    const conn = conns.find((c) => c.id === id);
    if (!conn) return;
    if (conn.type === 'sqlite') {
      setDbs([{ value: '', label: '（单文件库，无需选择）' }]);
      return;
    }
    if (!RELATIONAL.includes(conn.type)) {
      setDbs([{ value: '', label: '（该类型暂不支持备份）' }]);
      return;
    }
    try {
      // 打开临时会话列库，列完即关
      const r = await window.api.db.call(id, 'treeRoot');
      if (r && r.ok) {
        setDbs(r.data.map((x) => ({ value: x.name, label: x.name })));
      }
    } catch {
      setDbs([]);
    }
  };

  return (
    <Modal
      open={open}
      title={record ? '编辑备份计划' : '新建备份计划'}
      width={560}
      okText="保存"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: !name.trim() || !connId }}
      onOk={async () => {
        const conn = conns.find((c) => c.id === connId);
        setBusy(true);
        try {
          await backupApi.save({
            id: record ? record.id : undefined,
            name: name.trim(),
            connId,
            connName: conn ? conn.name : '',
            db: db.trim(),
            schema: schema.trim(),
            tables: tables.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
            dir: dir.trim(),
            mode,
            time,
            minutes: Number(minutes) || 60,
            enabled: record ? record.enabled : true,
          });
          message.success('计划已保存');
          onSaved();
        } catch (e) {
          message.error(e.message);
        } finally {
          setBusy(false);
        }
      }}
      onCancel={onClose}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <div>
          <div style={{ marginBottom: 4 }}>计划名称：</div>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>连接（需支持备份：MySQL/PG/SQLite/MSSQL/Oracle）：</div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择连接"
            value={connId || undefined}
            onChange={pickConn}
            options={conns.filter((c) => RELATIONAL.includes(c.type)).map((c) => ({ value: c.id, label: `${c.name}（${TYPE_LABEL[c.type] || c.type}）` }))}
          />
        </div>
        <Space style={{ display: 'flex' }} align="start" wrap>
          <div>
            <div style={{ marginBottom: 4 }}>数据库：</div>
            {dbs.length ? (
              <Select style={{ width: 180 }} placeholder="选择库" value={db || undefined} onChange={setDb} options={dbs} allowClear />
            ) : (
              <Input style={{ width: 180 }} value={db} onChange={(e) => setDb(e.target.value)} placeholder="数据库名" />
            )}
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>schema（PG/MSSQL/Oracle）：</div>
            <Input style={{ width: 120 }} value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="可空" />
          </div>
        </Space>
        <div>
          <div style={{ marginBottom: 4 }}>表/视图（逗号分隔，留空 = 全部）：</div>
          <Input value={tables} onChange={(e) => setTables(e.target.value)} placeholder="例如：users, orders" />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>备份目录：</div>
          <Input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="默认 userData/backups"
            addonAfter={
              <Button type="text" size="small" icon={<FolderOpenOutlined />} style={{ margin: -4, padding: '0 4px' }} onClick={async () => {
                const d = await pickDir({ title: '选择备份保存目录' });
                if (d) setDir(d);
              }} />
            }
          />
        </div>
        <Space style={{ display: 'flex' }} align="end" wrap>
          <div>
            <div style={{ marginBottom: 4 }}>计划方式：</div>
            <Select
              style={{ width: 140 }}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'daily', label: '每天定时' },
                { value: 'interval', label: '固定间隔' },
              ]}
            />
          </div>
          {mode === 'daily' ? (
            <div>
              <div style={{ marginBottom: 4 }}>时间（HH:mm）：</div>
              <Input style={{ width: 100 }} value={time} onChange={(e) => setTime(e.target.value.replace(/[^\d:]/g, ''))} placeholder="03:00" />
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 4 }}>间隔（分钟）：</div>
              <Input style={{ width: 100 }} value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />
            </div>
          )}
        </Space>
      </Space>
    </Modal>
  );
}
