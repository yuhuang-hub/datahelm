import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Radio, Space, message } from 'antd';
import { CopyOutlined, ExportOutlined } from '@ant-design/icons';
import { copyText, saveFile } from '../api';
import { FORMATS, buildExport } from '../exportUtil';

// 统一导出弹窗：
//   state = { title, columns, rows, fetchRows?, totalHint?, table?, name?, hint? }
//   - columns/rows：内存数据（结果集 / 当前页）
//   - fetchRows：按需抓全量（返回 {columns, rows}，自动翻页）；提供且 rows 非空时可选“当前页/全部”
//   - table：SQL INSERT 的默认表名（可改）
export default function ExportModal({ state, onClose }) {
  const open = !!state;
  const [fmt, setFmt] = useState('csv');
  const [scope, setScope] = useState('all');
  const [tbl, setTbl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state) {
      setFmt('csv');
      setScope('all');
      setTbl(state.table || '');
    }
  }, [state]);

  if (!state) return null;
  const hasPage = Array.isArray(state.rows) && state.rows.length > 0;
  const showScope = !!state.fetchRows && hasPage;

  const getData = async () => {
    if (state.fetchRows && scope === 'all') {
      const r = await state.fetchRows();
      return { columns: r.columns, rows: r.rows };
    }
    return { columns: state.columns, rows: state.rows || [] };
  };

  const build = async () => {
    const { columns, rows } = await getData();
    return { text: buildExport(fmt, columns, rows, tbl, state.title), n: rows.length };
  };

  const toFile = async () => {
    setBusy(true);
    try {
      const { text, n } = await build();
      const f = FORMATS.find((x) => x.v === fmt);
      const p = await saveFile({
        title: '导出为文件',
        defaultPath: `${state.name || state.table || 'export'}.${f.ext}`,
        filters: [{ name: f.l, extensions: [f.ext] }],
        content: text,
      });
      if (p) message.success(`已导出 ${n} 行：${p}`);
    } catch (e) {
      message.error('导出失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const toClip = async () => {
    setBusy(true);
    try {
      const { text, n } = await build();
      await copyText(text);
      message.success(`已复制 ${n} 行到剪贴板`);
      onClose();
    } catch (e) {
      message.error('复制失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <span>
          <ExportOutlined style={{ color: '#0e8a6a', marginRight: 6 }} />
          {state.title || '导出数据'}
        </span>
      }
      onCancel={onClose}
      footer={
        <Space>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button icon={<CopyOutlined />} disabled={busy} onClick={toClip}>
            复制到剪贴板
          </Button>
          <Button type="primary" icon={<ExportOutlined />} loading={busy} onClick={toFile}>
            导出为文件…
          </Button>
        </Space>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
        <div>
          <div style={{ marginBottom: 6, color: '#666' }}>格式</div>
          <Radio.Group
            optionType="button"
            buttonSize="small"
            value={fmt}
            onChange={(e) => setFmt(e.target.value)}
            options={FORMATS.map((f) => ({ value: f.v, label: f.l }))}
          />
        </div>
        {fmt === 'sql' && (
          <div>
            <div style={{ marginBottom: 6, color: '#666' }}>INSERT 目标表名</div>
            <Input size="small" style={{ width: 260 }} placeholder="TABLE1" value={tbl} onChange={(e) => setTbl(e.target.value)} />
          </div>
        )}
        {showScope && (
          <div>
            <div style={{ marginBottom: 6, color: '#666' }}>范围</div>
            <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
              <Radio value="all">全部行{state.totalHint != null ? `（${state.totalHint} 行）` : ''}</Radio>
              <Radio value="page">仅当前页（{state.rows.length} 行）</Radio>
            </Radio.Group>
          </div>
        )}
        {state.hint ? <Alert type="info" showIcon message={state.hint} /> : null}
        <div style={{ color: '#999', fontSize: 12 }}>
          CSV 带表头与 BOM（Excel 直接打开不乱码）；JSON 保留原生类型；SQL 为每 500 行一条的批量 INSERT。
        </div>
      </div>
    </Modal>
  );
}
