import React, { useLayoutEffect, useRef, useState } from 'react';
import { Menu } from 'antd';

// 固定定位右键菜单（自渲染，不经过 rc-trigger）：
// 先按光标渲染，量出实际尺寸后翻转/钳制到窗口内；高于视口时内部滚动
export default function FloatMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = r.width || 220;
    const h = r.height || 320;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [x, y, items]);

  return (
    <div className="ctx-menu" ref={ref} style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1050 }}>
      <Menu items={items} onClick={onClose} />
    </div>
  );
}
