import React, { useEffect, useState } from 'react';
import { Button, Empty, Input, List, Modal, Space, message } from 'antd';
import { DeleteOutlined, EditOutlined, FolderOpenOutlined, SearchOutlined } from '@ant-design/icons';
import { queriesApi } from '../api';

// 已保存查询列表：双击/点击打开到新查询标签
export default function SavedQueriesModal({ open, onClose, onOpenQuery }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState(null); // {id, value}

  const load = async () => {
    try {
      setItems(await queriesApi.list());
    } catch (e) {
      message.error(e.message);
    }
  };
  useEffect(() => {
    if (open) {
      load();
      setSearch('');
    }
  }, [open]);

  const shown = search.trim()
    ? items.filter((q) => (q.name + ' ' + (q.text || '')).toLowerCase().includes(search.trim().toLowerCase()))
    : items;

  return (
    <Modal
      open={open}
      title="查询列表（已保存）"
      footer={null}
      onCancel={onClose}
      width={720}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#bbb' }} />}
          placeholder="搜索名称或内容…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {shown.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无保存的查询（在查询窗口点「保存查询」）" style={{ padding: 20 }} />
        ) : (
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <List
              size="small"
              dataSource={shown}
              renderItem={(q) => (
                <List.Item
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    onOpenQuery(q);
                    onClose();
                  }}
                  title="点击在新查询窗口打开"
                  actions={[
                    <Button
                      key="ren"
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenaming({ id: q.id, value: q.name });
                      }}
                    />,
                    <Button
                      key="del"
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      title="删除"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const res = await queriesApi.remove(q.id);
                        if (res && res.ok === false) {
                          message.error('删除失败：' + (res.error || '未知错误'));
                        }
                        load();
                      }}
                    />,
                  ]}
                >
                  <List.Item.Meta
                    avatar={<FolderOpenOutlined style={{ fontSize: 16, color: '#0e8a6a', marginTop: 4 }} />}
                    title={<span>{q.name}</span>}
                    description={
                      <span style={{ fontFamily: 'Consolas, monospace' }}>
                        {(q.text || '').replace(/\s+/g, ' ').slice(0, 90)}
                        <span style={{ color: '#bbb', marginLeft: 8 }}>
                          {q.db ? q.db : ''} · {new Date(q.updatedAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}
                        </span>
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          </div>
        )}
      </Space>
      <Modal
        open={!!renaming}
        title="重命名查询"
        okText="确定"
        cancelText="取消"
        onCancel={() => setRenaming(null)}
        onOk={async () => {
          if (renaming && renaming.value.trim()) {
            await queriesApi.save({ id: renaming.id, name: renaming.value.trim() });
            load();
          }
          setRenaming(null);
        }}
      >
        <Input value={renaming ? renaming.value : ''} onChange={(e) => setRenaming({ id: renaming.id, value: e.target.value })} />
      </Modal>
    </Modal>
  );
}
