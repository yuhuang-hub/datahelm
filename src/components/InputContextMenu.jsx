import React, { useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { CopyOutlined, RedoOutlined, ScissorOutlined, SelectOutlined, SnippetsOutlined, UndoOutlined } from '@ant-design/icons';
import FloatMenu from './FloatMenu';

const SKIP_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color', 'hidden']);

// 全局输入框右键菜单：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选。
// 已自带自定义菜单的输入区（SQL 编辑器、侧栏树等）会在自身 handler 里 preventDefault，
// 这里检测 defaultPrevented 后自动跳过，不与组件专属菜单冲突。
export default function InputContextMenu() {
  const [menu, setMenu] = useState(null); // { x, y, selLen, editable }
  const elRef = useRef(null);

  useEffect(() => {
    const onCtx = (e) => {
      if (e.defaultPrevented) return;
      const t = e.target;
      if (!t || !t.closest) return;
      const el = t.closest('input, textarea, [contenteditable="true"]');
      if (!el || el.disabled) return;
      if (el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(String(el.type || 'text').toLowerCase())) return;
      e.preventDefault();
      elRef.current = el;
      let selLen = 0;
      if (el.isContentEditable) {
        selLen = window.getSelection ? String(window.getSelection()).length : 0;
      } else {
        selLen = Math.abs((el.selectionEnd || 0) - (el.selectionStart || 0));
      }
      setMenu({ x: e.clientX, y: e.clientY, selLen, editable: !el.readOnly });
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);

  // 点菜单外 / ESC 关闭（与侧栏、编辑器菜单一致的行为；此前空白左键关不掉）
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => {
      if (!e.target.closest || !e.target.closest('.ctx-menu')) setMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  if (!menu) return null;
  const focusEl = () => {
    const t = elRef.current;
    if (t && t.focus) t.focus();
  };
  const exec = (cmd) => {
    focusEl();
    document.execCommand(cmd);
  };
  return (
    <FloatMenu
      x={menu.x}
      y={menu.y}
      onClose={() => setMenu(null)}
      items={[
        { key: 'undo', label: '撤销', icon: <UndoOutlined />, disabled: !menu.editable, onClick: () => exec('undo') },
        { key: 'redo', label: '重做', icon: <RedoOutlined />, disabled: !menu.editable, onClick: () => exec('redo') },
        { type: 'divider' },
        { key: 'cut', label: '剪切', icon: <ScissorOutlined />, disabled: !menu.editable || !menu.selLen, onClick: () => exec('cut') },
        { key: 'copy', label: '复制', icon: <CopyOutlined />, disabled: !menu.selLen, onClick: () => exec('copy') },
        {
          key: 'paste',
          label: '粘贴',
          icon: <SnippetsOutlined />,
          disabled: !menu.editable,
          // insertText 走输入框原生 undo 栈，Ctrl+Z 可撤销粘贴
          onClick: () =>
            navigator.clipboard
              .readText()
              .then((t) => {
                focusEl();
                if (t) document.execCommand('insertText', false, t);
              })
              .catch(() => message.error('粘贴失败：无法读取剪贴板')),
        },
        { type: 'divider' },
        {
          key: 'selall',
          label: '全选',
          icon: <SelectOutlined />,
          onClick: () => {
            const t = elRef.current;
            if (!t) return;
            if (typeof t.select === 'function') t.select();
            else {
              focusEl();
              document.execCommand('selectAll');
            }
          },
        },
      ]}
    />
  );
}
