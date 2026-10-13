import React, { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, Input, Modal, Space, Table, Tag, message } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { dbApi } from '../../api';
import { useGridHeight } from '../../format';

const TYPE_COLOR = { string: 'blue', hash: 'green', list: 'orange', set: 'purple', zset: 'cyan' };

// Redis 键浏览器：SCAN 分页 + 值查看 + 删除
export default function RedisTab({ connId, connName, dbIdx, onStatus }) {
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState('0');
  const [nextCursor, setNextCursor] = useState('0');
  const [pattern, setPattern] = useState('*');
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState([]);
  const [value, setValue] = useState(null); // { key, data }
  const [gridRef, gridH] = useGridHeight(60);

  const scan = useCallback(
    async (cur) => {
      setLoading(true);
      try {
        const r = await dbApi(connId, 'scanKeys', { db: dbIdx, pattern, cursor: cur, count: 200 });
        setRows(cur === '0' ? r.rows : (prev) => [...prev, ...r.rows]);
        setCursor(cur);
        setNextCursor(r.cursor);
        onStatus(`db${dbIdx}：已加载 ${cur === '0' ? r.rows.length : rows.length + r.rows.length} 键（cursor ${r.cursor}）`);
      } catch (e) {
        message.error(e.message);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connId, dbIdx, pattern]
  );

  useEffect(() => {
    scan('0');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, dbIdx]);

  const viewKey = async (key) => {
    try {
      const data = await dbApi(connId, 'keyValue', { db: dbIdx, key });
      setValue({ key, data });
    } catch (e) {
      message.error(e.message);
    }
  };

  const delSel = () => {
    Modal.confirm({
      title: `删除 ${sel.length} 个键？`,
      okType: 'danger',
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        try {
          const n = await dbApi(connId, 'delKey', { db: dbIdx, keys: sel });
          message.success(`已删除 ${n} 个键`);
          setSel([]);
          scan('0');
        } catch (e) {
          message.error(e.message);
        }
      },
    });
  };

  const columns = [
    { title: '键', dataIndex: 0, ellipsis: true, render: (v) => <span style={{ fontFamily: 'Consolas, monospace' }}>{v}</span> },
    {
      title: '类型',
      dataIndex: 1,
      width: 90,
      render: (v) => <Tag color={TYPE_COLOR[v] || 'default'}>{v}</Tag>,
    },
    {
      title: '操作',
      width: 130,
      render: (_, rec) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => viewKey(rec[0])}>
            查看
          </Button>
          <Button
            size="small"
            type="link"
            danger
            onClick={() =>
              Modal.confirm({
                title: `删除键 ${rec[0]}？`,
                okType: 'danger',
                okText: '删除',
                cancelText: '取消',
                onOk: async () => {
                  await dbApi(connId, 'delKey', { db: dbIdx, keys: [rec[0]] });
                  message.success('已删除');
                  scan('0');
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
        <Input
          size="small"
          style={{ width: 260 }}
          prefix={<SearchOutlined style={{ color: '#bbb' }} />}
          placeholder="键模式，如 user:*"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onPressEnter={() => scan('0')}
        />
        <Button size="small" type="primary" icon={<ReloadOutlined />} loading={loading} onClick={() => scan('0')}>
          扫描
        </Button>
        {nextCursor !== '0' && (
          <Button size="small" onClick={() => scan(nextCursor)} disabled={loading}>
            继续扫描（cursor {nextCursor.slice(0, 8)}…）
          </Button>
        )}
        <span className="toolbar-spacer" />
        <Button size="small" danger icon={<DeleteOutlined />} disabled={!sel.length} onClick={delSel}>
          删除{sel.length ? `(${sel.length})` : ''}
        </Button>
        <span className="ctx">{connName} · db{dbIdx}</span>
      </div>
      <div className="grid-area" ref={gridRef}>
        <Table
          size="small"
          virtual
          columns={columns}
          dataSource={rows}
          rowKey={(_, i) => i}
          pagination={false}
          loading={loading}
          scroll={{ x: 'max-content', y: gridH }}
          rowSelection={{ selectedRowKeys: sel, onChange: (keys) => setSel(keys.map((i) => rows[i][0])) }}
        />
      </div>
      <Drawer
        title={value && <span style={{ fontFamily: 'Consolas, monospace', fontSize: 13 }}>{value.key}</span>}
        open={!!value}
        onClose={() => setValue(null)}
        width={520}
      >
        {value && <ValueView connId={connId} dbIdx={dbIdx} data={value.data} onDeleted={() => { setValue(null); scan('0'); }} k={value.key} />}
      </Drawer>
    </div>
  );
}

function ValueView({ data }) {
  const { type } = data;
  if (type === 'string') {
    return <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'Consolas, monospace' }}>{data.text}</pre>;
  }
  if (type === 'hash' && data.pairs) {
    return (
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <tbody>
          {data.pairs.map(([k, v]) => (
            <tr key={k}>
              <td style={{ border: '1px solid #eee', padding: '3px 6px', fontFamily: 'Consolas, monospace', width: '40%' }}>{k}</td>
              <td style={{ border: '1px solid #eee', padding: '3px 6px', fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (data.items) {
    return (
      <ul style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>
        {data.items.map((x, i) => (
          <li key={i} style={{ wordBreak: 'break-all' }}>{String(x)}</li>
        ))}
      </ul>
    );
  }
  return <pre>{data.text || ''}</pre>;
}
