import React from 'react';

// 单元格显示格式化（四方言值统一为 string/number/boolean/null/Date/Uint8Array）
export function fmt(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  if (v instanceof Uint8Array) {
    const hex = Array.from(v.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return `0x${hex}…(${v.length}B)`;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// 容器自适应高度（antd Table scroll.y 需要数值）
export function useGridHeight(offset = 0) {
  const ref = React.useRef(null);
  const [h, setH] = React.useState(360);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setH(Math.max(120, el.clientHeight - offset)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [offset]);
  return [ref, h];
}
