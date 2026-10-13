import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Empty, Input, Modal, Popover, Spin, message } from 'antd';
import {
  ApartmentOutlined, DownloadOutlined, LayoutOutlined, KeyOutlined,
  SaveOutlined, ZoomInOutlined, ZoomOutOutlined, CompressOutlined,
} from '@ant-design/icons';
import { dbApi, saveFile, modelApi } from '../../api';

// ER 图几何常量（连线锚点按「表头高 + 行高×列序」计算，DOM 与导出画布共用）
const BOX_W = 200;
const HEAD_H = 28;
const ROW_H = 20;
const GAP_X = 80;
const GAP_Y = 44;
const MAX_DEFAULT_TABLES = 30;

const clampZoom = (z) => Math.min(2, Math.max(0.4, Math.round(z * 100) / 100));

// 网格自动布局：按列累加高度，避免盒子纵向重叠（列数随表数量自适应）
function gridLayout(names, meta) {
  const cols = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(names.length)) || 1));
  const colY = new Array(cols).fill(20);
  const out = {};
  names.forEach((n, i) => {
    const c = i % cols;
    const rows = Math.max(1, (meta[n] && meta[n].columns.length) || 1);
    out[n] = { x: 20 + c * (BOX_W + GAP_X), y: colY[c] };
    colY[c] += HEAD_H + rows * ROW_H + GAP_Y;
  });
  return out;
}

// ER 图页签：库/schema 的表关系图（表盒子 + 外键连线 + 拖拽布局 + 缩放 + 导出 PNG）；
// initTables 非空时为「保存的模型」视图（固定表集，不随库内表增减变化）
export default function ErTab({ connId, connName, db, schema, initTables, modelName, onStatus }) {
  const [tables, setTables] = useState([]);
  const [sel, setSel] = useState({}); // name -> true
  const [meta, setMeta] = useState({}); // name -> { columns:[{name,dataType,pk,nullable}], fks:[{name,columns,refTable,refColumns}] }
  const [pos, setPos] = useState({});
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickSearch, setPickSearch] = useState('');
  const [saveOpen, setSaveOpen] = useState(false); // 保存为模型弹窗
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const metaRef = useRef({});
  const posRef = useRef({});
  posRef.current = pos;

  // 模型与全库 ER 的布局分开保存
  const erKey = useCallback(() => {
    const base = `dh_er_${connId}_${db || ''}|${schema || ''}`;
    return initTables && initTables.length ? `${base}_m_${modelName || ' unnamed'}` : base;
  }, [connId, db, schema, initTables, modelName]);
  const persistPos = useCallback(() => {
    try { localStorage.setItem(erKey(), JSON.stringify(posRef.current)); } catch {}
  }, [erKey]);

  const loadMeta = useCallback(async (names) => {
    const missing = names.filter((n) => !metaRef.current[n]);
    if (!missing.length) return;
    setLoading(true);
    const queue = [...missing];
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        try {
          const columns = await dbApi(connId, 'columns', { db, schema, table: t });
          const fks = await dbApi(connId, 'fkeys', { db, schema, table: t }).catch(() => []);
          metaRef.current = { ...metaRef.current, [t]: { columns: columns || [], fks: fks || [] } };
        } catch {
          metaRef.current = { ...metaRef.current, [t]: { columns: [], fks: [] } };
        }
        setMeta(metaRef.current);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, missing.length) }, worker));
    setLoading(false);
    return metaRef.current;
  }, [connId, db, schema]);

  // 初始化：表列表（模型=固定表集，全部选中）→ 拉元数据 → 恢复保存的布局/新表补格位
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ts = initTables && initTables.length
          ? initTables.slice()
          : await dbApi(connId, 'tables', { db, schema });
        if (!alive) return;
        setTables(ts);
        const capped = initTables && initTables.length ? ts : ts.slice(0, MAX_DEFAULT_TABLES);
        const selMap = {};
        capped.forEach((n) => { selMap[n] = true; });
        setSel(selMap);
        const m = await loadMeta(capped);
        if (!alive) return;
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(erKey()) || '{}'); } catch {}
        const auto = gridLayout(capped, m);
        const merged = {};
        capped.forEach((n) => {
          const s = saved[n];
          merged[n] = s && Number.isFinite(s.x) && Number.isFinite(s.y) ? { x: s.x, y: s.y } : auto[n];
        });
        setPos(merged);
        if (initTables && initTables.length) onStatus(`模型「${modelName || ''}」：${capped.length} 张表已加载`);
        else if (ts.length > capped.length) onStatus(`ER 图：共 ${ts.length} 张表，默认显示前 ${MAX_DEFAULT_TABLES} 张，可在「选择表」中调整`);
        else onStatus(`ER 图：${capped.length} 张表已加载`);
      } catch (e) {
        message.error('加载表列表失败：' + e.message);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selArr = useMemo(() => tables.filter((n) => sel[n]), [tables, sel]);
  const boxH = useCallback((name) => HEAD_H + Math.max(1, (meta[name] && meta[name].columns.length) || 1) * ROW_H, [meta]);

  // 外键连线：子表列锚点 → 父表列锚点（贝塞尔），两端朝向按盒子相对位置决定
  const edges = useMemo(() => {
    const lowerMap = {};
    selArr.forEach((n) => { lowerMap[n.toLowerCase()] = n; });
    const out = [];
    selArr.forEach((t) => {
      const m = meta[t];
      if (!m) return;
      m.fks.forEach((fk) => {
        const pt = lowerMap[String(fk.refTable || '').toLowerCase()];
        if (!pt || pt === t) return;
        const cp = pos[t];
        const pp = pos[pt];
        if (!cp || !pp) return;
        const ci = Math.max(0, m.columns.findIndex((c) => c.name === fk.columns[0]));
        const pm = meta[pt];
        const pi = pm ? Math.max(0, pm.columns.findIndex((c) => c.name === (fk.refColumns || [])[0])) : 0;
        const y1 = cp.y + HEAD_H + ci * ROW_H + ROW_H / 2;
        const y2 = pp.y + HEAD_H + pi * ROW_H + ROW_H / 2;
        let x1;
        let x2;
        if (cp.x + BOX_W / 2 <= pp.x + BOX_W / 2) { x1 = cp.x + BOX_W; x2 = pp.x; } else { x1 = cp.x; x2 = pp.x + BOX_W; }
        const mx = (x1 + x2) / 2;
        out.push({
          key: `${t}.${fk.name}`,
          d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
          x1, y1, x2, y2,
          label: `${t}.${(fk.columns || [])[0] || ''} → ${pt}.${(fk.refColumns || [])[0] || ''}`,
        });
      });
    });
    return out;
  }, [selArr, meta, pos]);

  const world = useMemo(() => {
    let w = 400;
    let h = 300;
    selArr.forEach((n) => {
      const p = pos[n];
      if (!p) return;
      w = Math.max(w, p.x + BOX_W + 60);
      h = Math.max(h, p.y + boxH(n) + 60);
    });
    return { w, h };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selArr, pos, meta]);

  // 盒子拖拽（按缩放比换算坐标增量），松手时持久化布局
  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const nx = d.ox + (e.clientX - d.startX) / zoom;
      const ny = d.oy + (e.clientY - d.startY) / zoom;
      setPos((p) => ({ ...p, [d.name]: { x: Math.round(nx), y: Math.round(ny) } }));
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        persistPos();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [zoom, persistPos]);

  const onBoxMouseDown = (e, name) => {
    if (e.button !== 0) return;
    const p = pos[name];
    if (!p) return;
    e.preventDefault();
    dragRef.current = { name, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y };
  };

  // Ctrl+滚轮缩放（普通滚轮保持画布滚动）；React onWheel 是 passive，须原生监听
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 0.9)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const autoLayout = () => {
    // 自动排列整体重排（覆盖已保存布局并重新持久化）
    setPos(gridLayout(selArr, meta));
    setTimeout(persistPos, 0);
    onStatus('ER 图：已按网格自动排列');
  };

  const fitView = () => {
    const el = canvasRef.current;
    if (!el || !selArr.length) return;
    const z = clampZoom(Math.min(el.clientWidth / world.w, el.clientHeight / world.h) * 0.96);
    setZoom(z);
    if (el.scrollTo) el.scrollTo(0, 0);
    onStatus(`ER 图：已适应画布（${Math.round(z * 100)}%）`);
  };

  const toggleSel = (name, on) => {
    setSel((s) => {
      const n = { ...s };
      if (on) n[name] = true;
      else delete n[name];
      return n;
    });
    if (on && !metaRef.current[name]) {
      loadMeta([name]).then(() => {
        setPos((p) => {
          if (p[name]) return p;
          const maxY = Math.max(20, ...selArr.map((n) => (p[n] ? p[n].y + boxH(n) : 0)));
          return { ...p, [name]: { x: 20, y: maxY + GAP_Y } };
        });
      });
    }
  };

  // 导出 PNG：用 canvas 2D 复刻盒子与连线（几何常量共用），二进制落盘走 base64
  const exportPng = async () => {
    if (!selArr.length) return;
    const S = 2;
    const cv = document.createElement('canvas');
    cv.width = world.w * S;
    cv.height = world.h * S;
    const g = cv.getContext('2d');
    g.scale(S, S);
    g.fillStyle = '#f4f6f5';
    g.fillRect(0, 0, world.w, world.h);
    g.strokeStyle = '#2e9e7a';
    g.lineWidth = 1.5;
    edges.forEach((e) => {
      const mx = (e.x1 + e.x2) / 2;
      g.beginPath();
      g.moveTo(e.x1, e.y1);
      g.bezierCurveTo(mx, e.y1, mx, e.y2, e.x2, e.y2);
      g.stroke();
      [[e.x1, e.y1], [e.x2, e.y2]].forEach(([x, y]) => {
        g.beginPath();
        g.arc(x, y, 3, 0, Math.PI * 2);
        g.fillStyle = '#2e9e7a';
        g.fill();
      });
    });
    selArr.forEach((n) => {
      const p = pos[n];
      const m = meta[n];
      if (!p || !m) return;
      const h = HEAD_H + Math.max(1, m.columns.length) * ROW_H;
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#c9d4ce';
      g.beginPath();
      g.roundRect(p.x, p.y, BOX_W, h, 4);
      g.fill();
      g.stroke();
      g.fillStyle = '#35544b';
      g.beginPath();
      g.roundRect(p.x, p.y, BOX_W, HEAD_H, [4, 4, 0, 0]);
      g.fill();
      g.fillStyle = '#fff';
      g.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
      g.textBaseline = 'middle';
      g.fillText(n, p.x + 8, p.y + HEAD_H / 2 + 1, BOX_W - 16);
      m.columns.forEach((c, i) => {
        const y = p.y + HEAD_H + i * ROW_H + ROW_H / 2 + 1;
        let tx = p.x + 8;
        if (c.pk) {
          g.fillStyle = '#d48806';
          g.font = '600 9px sans-serif';
          g.fillText('PK', tx, y);
          tx += 16;
        }
        g.fillStyle = c.pk ? '#a06a08' : '#333';
        g.font = `${c.nullable ? '' : '600 '}12px Consolas, monospace`;
        g.fillText(c.name, tx, y, BOX_W - 70 - (c.pk ? 16 : 0));
        g.fillStyle = '#999';
        g.font = '11px Consolas, monospace';
        g.textAlign = 'right';
        g.fillText(String(c.dataType || ''), p.x + BOX_W - 8, y);
        g.textAlign = 'left';
      });
    });
    try {
      const fp = await saveFile({
        title: '导出 ER 图',
        defaultPath: `er-${db || schema || 'main'}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        base64: true,
        content: cv.toDataURL('image/png').split(',')[1],
      });
      if (fp) message.success(`ER 图已导出：${fp}`);
    } catch (e) {
      message.error('导出失败：' + e.message);
    }
  };

  const relCount = edges.length;
  const filteredTables = useMemo(
    () => (pickSearch.trim() ? tables.filter((t) => t.toLowerCase().includes(pickSearch.trim().toLowerCase())) : tables),
    [tables, pickSearch]
  );

  // 保存当前勾选的表为模型（应用层 models.json；再次打开即固定表集）
  const saveModel = async () => {
    if (!selArr.length) { message.warning('请先选择至少一张表'); return; }
    setSaving(true);
    try {
      await modelApi.save({ name: saveName.trim() || `模型 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, connId, db, schema, tables: selArr });
      message.success('模型已保存（左侧树 · 模型 目录）');
      setSaveOpen(false);
    } catch (e) {
      message.error('保存模型失败：' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const pickContent = (
    <div style={{ width: 250 }}>
      <Input size="small" allowClear placeholder="搜索表名" value={pickSearch} onChange={(e) => setPickSearch(e.target.value)} />
      <div className="er-pick-list">
        {filteredTables.map((t) => (
          <Checkbox key={t} checked={!!sel[t]} onChange={(e) => toggleSel(t, e.target.checked)}>
            <span style={{ fontFamily: 'Consolas, monospace' }}>{t}</span>
          </Checkbox>
        ))}
        {filteredTables.length === 0 && <div style={{ color: '#999', fontSize: 12, padding: '6px 0' }}>无匹配表</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button
          size="small"
          onClick={() => {
            const n = {};
            tables.forEach((t) => { n[t] = true; });
            setSel(n);
            loadMeta(tables);
          }}
        >
          全选
        </Button>
        <Button size="small" onClick={() => setSel({})}>清空</Button>
      </div>
    </div>
  );

  return (
    <div className="tab-body" data-dh-er="1">
      <div className="tab-toolbar">
        <Popover open={pickOpen} onOpenChange={setPickOpen} trigger="click" placement="bottomLeft" content={pickContent}>
          <Button size="small" icon={<ApartmentOutlined />}>选择表（{selArr.length}/{tables.length}）</Button>
        </Popover>
        <span className="ctx" style={{ marginLeft: 0 }}>{relCount} 条外键关系 · 拖动表盒子调整布局 · Ctrl+滚轮缩放</span>
        <span className="toolbar-spacer" />
        <Button size="small" icon={<ZoomOutOutlined />} onClick={() => setZoom((z) => clampZoom(z - 0.1))} title="缩小" />
        <span
          className="er-zoom"
          title="点击重置为 100%"
          onClick={() => setZoom(1)}
          data-dh-er-zoom={Math.round(zoom * 100)}
        >
          {Math.round(zoom * 100)}%
        </span>
        <Button size="small" icon={<ZoomInOutlined />} onClick={() => setZoom((z) => clampZoom(z + 0.1))} title="放大" />
        <Button size="small" icon={<CompressOutlined />} onClick={fitView} title="适应画布">适应</Button>
        <Button size="small" icon={<LayoutOutlined />} onClick={autoLayout} title="网格自动排列">排列</Button>
        <Button size="small" icon={<SaveOutlined />} onClick={() => { setSaveName(''); setSaveOpen(true); }} title="把当前勾选的表保存为模型（左侧树 · 模型）">保存为模型</Button>
        <Button size="small" icon={<DownloadOutlined />} onClick={exportPng} title="导出为 PNG 图片">导出 PNG</Button>
      </div>
      <div className="er-canvas" ref={canvasRef}>
        {tables.length === 0 && !loading ? (
          <Empty style={{ marginTop: 80 }} description="该库中没有表" />
        ) : (
          <div className="er-world" style={{ width: world.w, height: world.h, transform: `scale(${zoom})`, transformOrigin: '0 0' }}>
            <svg className="er-edges" width={world.w} height={world.h}>
              {edges.map((e) => (
                <g key={e.key}>
                  <path className="er-edge" data-dh-er-edge={e.key} d={e.d}>
                    <title>{e.label}</title>
                  </path>
                  <circle className="er-dot" cx={e.x1} cy={e.y1} r="3" />
                  <circle className="er-dot" cx={e.x2} cy={e.y2} r="3" />
                </g>
              ))}
            </svg>
            {selArr.map((n) => {
              const m = meta[n];
              const p = pos[n];
              if (!p) return null;
              return (
                <div
                  key={n}
                  className="er-table"
                  data-dh-er-table={n}
                  style={{ left: p.x, top: p.y, width: BOX_W }}
                  onMouseDown={(e) => onBoxMouseDown(e, n)}
                >
                  <div className="er-th">
                    <span className="nm">{n}</span>
                    <span className="ct">{m ? m.columns.length : '…'}</span>
                  </div>
                  {(m ? m.columns : []).map((c) => (
                    <div key={c.name} className={c.pk ? 'er-row pk' : 'er-row'}>
                      <span className="cname">
                        {c.pk ? <KeyOutlined className="kico" /> : null}
                        {c.name}
                      </span>
                      <span className="ctype">{c.dataType}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {loading && (
          <div className="er-loading">
            <Spin />
          </div>
        )}
      </div>
      <Modal
        open={saveOpen}
        title="保存为模型"
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        transitionName=""
        maskTransitionName=""
        onOk={saveModel}
        onCancel={() => setSaveOpen(false)}
      >
        <div style={{ marginBottom: 8 }}>
          将当前勾选的 <b>{selArr.length}</b> 张表保存为模型（{connName} · {db || schema || '默认'}），可在左侧树「模型」目录重新打开。
        </div>
        <Input
          size="small"
          placeholder="模型名（留空自动按时间命名）"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onPressEnter={saveModel}
          data-dh-er="modelname"
        />
      </Modal>
    </div>
  );
}
