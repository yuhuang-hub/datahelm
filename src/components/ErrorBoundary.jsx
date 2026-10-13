import React from 'react';
import { Button } from 'antd';

// 根级错误边界：渲染错误不再白屏整个应用 —— 落盘完整 stack + 组件栈（DH-ERR-BOUNDARY），
// 并给出「重新加载」恢复入口。ui-debug.log 里的 stack 用于离线定位（v0921.18 起）。
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    const stack = String((err && err.stack) || '').slice(0, 900);
    const comp = String((info && info.componentStack) || '').replace(/\s+/g, ' ').slice(0, 500);
    console.log(`DH-ERR-BOUNDARY ${String((err && err.message) || err).slice(0, 200)} | STACK ${stack} | COMP ${comp}`);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="dh-err-boundary" style={{ padding: 24, height: '100%', overflow: 'auto' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>界面渲染出错</div>
        <div style={{ color: '#888', fontSize: 12, marginBottom: 16, wordBreak: 'break-all' }}>
          {String((this.state.err && this.state.err.message) || this.state.err)}
        </div>
        <Button type="primary" size="small" onClick={() => window.location.reload()}>重新加载</Button>
      </div>
    );
  }
}

// 崩溃探针（验证边界用）：window.__dhThrowRender = 1 后任意一次应用重渲染都会抛 #130
export function DhCrashProbe() {
  if (typeof window !== 'undefined' && window.__dhThrowRender) {
    const Bad = undefined;
    return <Bad />;
  }
  return null;
}
