import React, { useEffect, useState } from 'react';
import { Button, Input, message, Modal, Switch, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, UndoOutlined } from '@ant-design/icons';
import { LABEL_RE, loadCfg, resetCfg, saveCfg } from '../completionStore';

// 补全设置（v0927.44）：片段清单（新建/编辑/删除/恢复默认）+ 片段/关键字开关。
// 改动即时生效（saveCfg 持久化并广播，SqlEditor 弹层打开时读最新配置）。入口：状态栏齿轮、
// 查询编辑器右键「补全设置…」（dh-open-acset 事件）。禁用进出动画：关闭紧跟整树重渲染，
// zoom-leave 动画在锁屏/遮挡下会卡成全屏遮挡层（同 App 关闭确认弹窗的处理）。
export default function CompletionSettingsModal({ open, onClose }) {
  const [cfg, setCfg] = useState(null);
  const [editing, setEditing] = useState(null); // { orig, label, template }：orig 为空即新建
  useEffect(() => {
    if (open) {
      setCfg(loadCfg());
      setEditing(null);
    }
  }, [open]);
  if (!open || !cfg) return null;

  const apply = (next) => setCfg(saveCfg(next));
  const toggle = (k, v) => apply({ ...cfg, [k]: v });
  const delSnip = (label) => {
    apply({ ...cfg, snippets: cfg.snippets.filter((s) => s.label !== label) });
    if (editing && editing.orig === label) setEditing(null);
  };
  const saveEdit = () => {
    const label = editing.label.trim();
    if (!LABEL_RE.test(label)) {
      message.warning('前缀需以字母开头，仅限字母/数字/下划线，最长 16 位');
      return;
    }
    if (!editing.template.trim()) {
      message.warning('模板不能为空');
      return;
    }
    if (cfg.snippets.some((s) => s.label === label && s.label !== editing.orig)) {
      message.warning('前缀已存在：' + label);
      return;
    }
    apply({ ...cfg, snippets: [...cfg.snippets.filter((s) => s.label !== editing.orig), { label, template: editing.template, detail: '' }] });
    setEditing(null);
  };

  return (
    <Modal
      open={open}
      title="补全设置"
      footer={null}
      onCancel={onClose}
      width={660}
      className="acset-modal"
      transitionName=""
      maskTransitionName=""
    >
      <div className="acset-bar">
        <label className="acset-tg">
          片段补全
          <Switch size="small" checked={cfg.snippetsOn} onChange={(v) => toggle('snippetsOn', v)} data-dh-cs="snip-switch" />
        </label>
        <label className="acset-tg">
          关键字补全
          <Switch size="small" checked={cfg.keywordsOn} onChange={(v) => toggle('keywordsOn', v)} data-dh-cs="kw-switch" />
        </label>
        <span className="acset-bar-space" />
        <Button size="small" icon={<PlusOutlined />} onClick={() => setEditing({ orig: '', label: '', template: '' })} data-dh-cs="snip-new">
          新建片段
        </Button>
        <Button
          size="small"
          icon={<UndoOutlined />}
          onClick={() => {
            setCfg(resetCfg());
            setEditing(null);
          }}
          data-dh-cs="reset"
        >
          恢复默认
        </Button>
      </div>
      <div className="acset-list" data-dh-cs="list">
        {cfg.snippets.length === 0 ? (
          <div className="acset-empty">暂无片段（已全部删除），点「恢复默认」找回内置片段。</div>
        ) : (
          cfg.snippets.map((s) => (
            <div className="acset-row" key={s.label} data-dh-cs="row" data-label={s.label}>
              <span className="acset-label">{s.label}</span>
              <Tag className="acset-src" data-dh-cs={s.builtin ? 'src-builtin' : 'src-custom'}>
                {s.builtin ? '内置' : '自定义'}
              </Tag>
              <span className="acset-detail">{(s.template || '').replace(/\s+/g, ' ').slice(0, 46)}</span>
              <span className="acset-rowbtns">
                <Button type="text" size="small" icon={<EditOutlined />} title="编辑" onClick={() => setEditing({ orig: s.label, label: s.label, template: s.template })} />
                <Button type="text" size="small" danger icon={<DeleteOutlined />} title="删除" onClick={() => delSnip(s.label)} />
              </span>
            </div>
          ))
        )}
      </div>
      {editing && (
        <div className="acset-edit">
          <div className="acset-edit-row">
            <Input
              className="acset-prefix"
              placeholder="前缀（字母开头，如 cnt）"
              value={editing.label}
              maxLength={16}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              data-dh-cs="label-input"
            />
            <Button size="small" type="primary" onClick={saveEdit} data-dh-cs="save">
              保存片段
            </Button>
            <Button size="small" onClick={() => setEditing(null)}>取消</Button>
          </div>
          <Input.TextArea
            className="acset-tpl"
            rows={5}
            placeholder={'模板，例如：\nSELECT COUNT(*) FROM 表名'}
            value={editing.template}
            onChange={(e) => setEditing({ ...editing, template: e.target.value })}
            data-dh-cs="tpl-input"
          />
          <div className="acset-hint">占位符写法：$ 加花括号，括号内 序号:名称（如 1:表名），展开后 Tab 逐个跳转；保存后立即生效。</div>
        </div>
      )}
    </Modal>
  );
}
