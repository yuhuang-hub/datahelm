import React, { useEffect, useState } from 'react';
import { Button, Checkbox, Empty, Input, Modal, Space, Table, Tag, message } from 'antd';
import { PlusOutlined, ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import { dbApi } from '../../api';

const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'REFERENCES', 'TRUNCATE'];

// 用户与权限管理（MySQL / PostgreSQL）
export default function UsersTab({ connId, connName, session, onStatus }) {
  const type = session ? session.type : '';
  const supported = type === 'mysql' || type === 'mariadb' || type === 'postgres' || type === 'pg';
  const isPg = type === 'postgres' || type === 'pg';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [grantFor, setGrantFor] = useState(null); // {name, host}
  const [grants, setGrants] = useState(null); // {list, loading}

  const load = async () => {
    setLoading(true);
    try {
      setRows(await dbApi(connId, 'users'));
    } catch (e) {
      message.error('读取用户失败：' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (supported) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, supported]);

  if (!supported) {
    return (
      <div className="tab-body" style={{ alignItems: 'center', justifyContent: 'center', display: 'flex' }}>
        <Empty description={`「${type}」类型连接暂不支持用户管理（目前支持 MySQL / PostgreSQL）`} />
      </div>
    );
  }

  const dropUser = (row) =>
    Modal.confirm({
      title: `删除用户「${row.name}」？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () =>
        dbApi(connId, 'dropUser', { user: row.name, host: row.host })
          .then(() => {
            message.success('已删除');
            load();
          })
          .catch((e) => message.error(e.message)),
    });

  const showGrants = async (row) => {
    setGrants({ list: [], loading: true });
    try {
      const list = await dbApi(connId, 'listGrants', { user: row.name, host: row.host });
      setGrants({ list, loading: false });
    } catch (e) {
      setGrants({ list: [], loading: false });
      message.error(e.message);
    }
  };

  const columns = [
    { title: '用户', dataIndex: 'name', key: 'name' },
    !isPg && { title: 'Host', dataIndex: 'host', key: 'host' },
    isPg && {
      title: '属性',
      key: 'attrs',
      render: (_, r) => (
        <>
          {r.super ? <Tag color="red">超级用户</Tag> : null}
          {r.canLogin ? <Tag color="green">可登录</Tag> : <Tag>禁止登录</Tag>}
        </>
      ),
    },
    {
      title: '操作',
      key: 'op',
      width: 260,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" icon={<SafetyOutlined />} onClick={() => { setGrantFor(r); showGrants(r); }}>
            权限
          </Button>
          <Button size="small" danger onClick={() => dropUser(r)}>
            删除
          </Button>
        </Space>
      ),
    },
  ].filter(Boolean);

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建用户
        </Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新
        </Button>
        <span className="ctx">
          {connName} · {session ? session.serverInfo : ''} · {rows.length} 个用户
        </span>
      </div>
      <div className="grid-area">
        <Table
          size="small"
          rowKey={(r) => r.name + '|' + (r.host || '')}
          columns={columns}
          dataSource={rows}
          pagination={false}
          loading={loading}
        />
      </div>

      <CreateUserModal
        open={createOpen}
        isPg={isPg}
        onClose={() => setCreateOpen(false)}
        onOk={async (v) => {
          await dbApi(connId, 'createUser', v);
          message.success('用户已创建');
          setCreateOpen(false);
          load();
        }}
      />

      <Modal
        open={!!grantFor}
        title={`权限：${grantFor ? grantFor.name : ''}`}
        footer={null}
        onCancel={() => setGrantFor(null)}
        width={640}
      >
        <GrantPanel
          connId={connId}
          isPg={isPg}
          row={grantFor}
          grants={grants}
          onGranted={() => {
            if (grantFor) showGrants(grantFor);
          }}
        />
      </Modal>
    </div>
  );
}

function CreateUserModal({ open, isPg, onClose, onOk }) {
  const [user, setUser] = useState('');
  const [host, setHost] = useState('%');
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setUser('');
      setHost('%');
      setPwd('');
    }
  }, [open]);
  return (
    <Modal
      open={open}
      title="新建用户"
      okText="创建"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: !user.trim() }}
      onCancel={onClose}
      onOk={async () => {
        setBusy(true);
        try {
          await onOk({ user: user.trim(), host: host.trim(), password: pwd });
        } catch (e) {
          message.error(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <div>
          <div style={{ marginBottom: 4 }}>用户名：</div>
          <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="app_user" />
        </div>
        {!isPg && (
          <div>
            <div style={{ marginBottom: 4 }}>允许的主机（% = 任意主机）：</div>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="%" />
          </div>
        )}
        <div>
          <div style={{ marginBottom: 4 }}>密码：</div>
          <Input.Password value={pwd} onChange={(e) => setPwd(e.target.value)} />
        </div>
      </Space>
    </Modal>
  );
}

function GrantPanel({ connId, isPg, row, grants, onGranted }) {
  const [sel, setSel] = useState(['SELECT']);
  const [db, setDb] = useState('');
  const [busy, setBusy] = useState(false);
  if (!row) return null;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={10}>
      <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 4, padding: 8, fontFamily: 'Consolas, monospace', fontSize: 12 }}>
        {grants && grants.loading ? (
          <span style={{ color: '#999' }}>读取中…</span>
        ) : grants && grants.list.length ? (
          grants.list.map((g, i) => <div key={i} style={{ padding: '2px 0' }}>{g}</div>)
        ) : (
          <span style={{ color: '#999' }}>（无或不可读）</span>
        )}
      </div>
      <div>
        <div style={{ marginBottom: 4 }}>快捷授权（{isPg ? '作用于数据库' : '作用于 db.*'}）：</div>
        <Checkbox.Group options={PRIVS} value={sel} onChange={setSel} />
      </div>
      <Space>
        <Input style={{ width: 220 }} placeholder={isPg ? '数据库名（空=public 模式全部表）' : '数据库名（空=全局 *.*）'} value={db} onChange={(e) => setDb(e.target.value)} />
        <Button
          size="small"
          type="primary"
          loading={busy}
          disabled={!sel.length}
          onClick={async () => {
            setBusy(true);
            try {
              await dbApi(connId, 'grantTo', { user: row.name, host: row.host, privs: sel, db });
              message.success('授权语句已执行');
              onGranted();
            } catch (e) {
              message.error(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          执行 GRANT
        </Button>
      </Space>
    </Space>
  );
}
