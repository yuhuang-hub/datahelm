import React, { useEffect, useState } from 'react';
import { Button, Space, Spin, message } from 'antd';
import { CopyOutlined, EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { dbApi, copyText } from '../../api';

// 对象源码查看（函数/存储过程/触发器/事件/序列/索引/回收站对象等）；tab 记录里 kind='ddl'，对象种类在 objKind
export default function DdlTab({ connId, connName, db, schema, objKind: kind, name, table, original, rtype, droptime, refreshKey, onStatus }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      // table：索引等表级对象；original/rtype/droptime：回收站对象信息
      setCode(await dbApi(connId, 'objectDdl', { db, schema, kind, name, table, original, rtype, droptime }));
    } catch (e) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, schema, kind, name]);

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <Space size={4}>
          <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => copyText(code).then(() => message.success('已复制'))}
          >
            复制
          </Button>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<EditOutlined />}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('dh-open-objedit', { detail: { connId, db, schema, kind, name, table, refreshKey } })
              )
            }
          >
            编辑
          </Button>
          <span className="ctx">
            {connName} · {kind} · {name}
          </span>
        </Space>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 10px' }}>
        {loading && !code ? (
          <Spin />
        ) : (
          <pre style={{ margin: 0, fontFamily: 'Consolas, monospace', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{code}</pre>
        )}
      </div>
    </div>
  );
}
