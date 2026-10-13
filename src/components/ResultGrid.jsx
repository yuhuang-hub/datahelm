import React from 'react';
import { Dropdown, Table, message } from 'antd';
import { CopyOutlined, ExportOutlined } from '@ant-design/icons';
import { copyText } from '../api';
import { fmt, useGridHeight } from '../format';

const csvEsc = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

// 只读结果网格（查询结果用）：单元格/表头右键可复制；可选 onExport 提供“导出结果…”入口
export default function ResultGrid({ columns, rows, emptyText, onExport }) {
  const [wrapRef, h] = useGridHeight(40);

  const copyAll = (withHeader) => {
    const lines = (rows || []).map((r) => (columns || []).map((_, ci) => csvEsc(fmt(r[ci]))).join(','));
    const text = withHeader ? (columns || []).map((n) => csvEsc(String(n))).join(',') + '\n' + lines.join('\n') : lines.join('\n');
    copyText(text).then(() => message.success(withHeader ? `已复制 ${lines.length} 行（含列名）` : `已复制 ${lines.length} 行`));
  };

  const cellMenuItems = [
    { key: 'copy', label: '复制单元格值', icon: <CopyOutlined /> },
    { key: 'copyrow', label: '复制本行（CSV）', icon: <CopyOutlined /> },
    { key: 'copyrowh', label: '复制本行（含列名）', icon: <CopyOutlined /> },
    { type: 'divider' },
    { key: 'copyall', label: `复制全部行（CSV，${(rows || []).length} 行）`, icon: <CopyOutlined /> },
    { key: 'copyallh', label: `复制全部行（含列名，${(rows || []).length} 行）`, icon: <CopyOutlined /> },
    ...(onExport
      ? [
          { type: 'divider' },
          { key: 'export', label: '导出结果…', icon: <ExportOutlined /> },
        ]
      : []),
  ];

  const cols = React.useMemo(
    () =>
      (columns || []).map((name, i) => ({
        key: String(i),
        title: (
          <Dropdown
            trigger={['contextMenu']}
            menu={{
              items: [{ key: 'copy', label: '复制列名', icon: <CopyOutlined /> }],
              onClick: () => copyText(String(name)).then(() => message.success('已复制列名')),
            }}
          >
            <span>{String(name)}</span>
          </Dropdown>
        ),
        dataIndex: i,
        ellipsis: true,
        width: 150,
        render: (v, rec) => (
          <Dropdown
            trigger={['contextMenu']}
            menu={{
              items: cellMenuItems,
              onClick: ({ key }) => {
                if (key === 'copy') {
                  copyText(fmt(v)).then(() => message.success('已复制单元格值'));
                } else if (key === 'copyrow') {
                  copyText((columns || []).map((_, ci) => csvEsc(fmt(rec[ci]))).join(','))
                    .then(() => message.success('已复制本行（CSV）'));
                } else if (key === 'copyrowh') {
                  const head = (columns || []).map((n) => csvEsc(String(n))).join(',');
                  const line = (columns || []).map((_, ci) => csvEsc(fmt(rec[ci]))).join(',');
                  copyText(head + '\n' + line).then(() => message.success('已复制本行（含列名）'));
                } else if (key === 'copyall') {
                  copyAll(false);
                } else if (key === 'copyallh') {
                  copyAll(true);
                } else if (key === 'export') {
                  onExport();
                }
              },
            }}
          >
            <div className={'cell' + (v == null ? ' null' : '')} title={fmt(v)}>
              {fmt(v)}
            </div>
          </Dropdown>
        ),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, rows, onExport]
  );
  return (
    <div ref={wrapRef} className="dh-grid" style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '0 2px' }}>
      <Table
        size="small"
        virtual
        columns={cols}
        dataSource={rows || []}
        rowKey={(_, i) => i}
        pagination={false}
        scroll={{ x: 'max-content', y: h }}
        locale={{ emptyText: emptyText || '无数据' }}
      />
    </div>
  );
}
