import React from 'react';

// DataHelm 软件图标（原子：电子绕原子核转）：与 electron/icons/icon.svg、启动动画、
// 主窗图标同一设计。空状态等界面内场景使用；不需要随主题变色（品牌固定配色）。
export default function AppIcon({ size = 40, className = '', style }) {
  return (
    <svg
      className={`dh-appicon${className ? ` ${className}` : ''}`}
      data-dh-ico="app"
      width={size}
      height={size}
      viewBox="0 0 128 128"
      aria-hidden="true"
      style={{ display: 'block', ...style }}
    >
      <defs>
        <linearGradient id="dhbg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#12a97f" />
          <stop offset="1" stopColor="#0b6e56" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#dhbg)" />
      <g fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round">
        <ellipse cx="64" cy="64" rx="45" ry="17" />
        <ellipse cx="64" cy="64" rx="45" ry="17" transform="rotate(60 64 64)" />
        <ellipse cx="64" cy="64" rx="45" ry="17" transform="rotate(120 64 64)" />
      </g>
      <circle cx="64" cy="64" r="10" fill="#e9bd63" stroke="#0b6e56" strokeWidth="3" />
      <g fill="#e9bd63" stroke="#0b6e56" strokeWidth="2.5">
        <circle cx="109" cy="64" r="5.5" />
        <circle cx="109" cy="64" r="5.5" transform="rotate(60 64 64)" />
        <circle cx="109" cy="64" r="5.5" transform="rotate(120 64 64)" />
      </g>
    </svg>
  );
}
