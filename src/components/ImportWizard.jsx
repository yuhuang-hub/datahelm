import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Progress, Radio, Select, Steps, Table, message } from 'antd';
import { FileSearchOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { dbApi, impApi, pickFile } from '../api';
import { fmt } from '../format';

// 导入向导（Navicat 式四步）：文件（CSV/JSON）→ 目标（新建表/现有表）→ 字段映射 → 执行
// 写入走各驱动已有的 insertRows（参数化、分批、逐批事务）；新建表走 createTable，
// 列类型统一三族 BIGINT/DOUBLE/TEXT（oracle 的 fullType 自动映射 NUMBER(19)/BINARY_DOUBLE/CLOB）
const KIND_TYPE = { int: 'BIGINT', real: 'DOUBLE', text: 'TEXT' };
const KIND_CN = { int: '整数', real: '小数', text: '文本' };
const INT_RE = /^-?\d+$/;
const REAL_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const NUM_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|number|bit|serial|money)/i;

// 按全量数据推断列族：全部可解析为整数 → int；小数 → real；其余/全空 → text
function inferKinds(header, rows) {
  return header.map((_, i) => {
    let int = true;
    let real = true;
    let seen = false;
    for (const r of rows) {
      const v = r[i];
      if (v === null || v === undefined || v === '') continue;
      seen = true;
      const s = String(v).trim();
      if (!INT_RE.test(s)) int = false;
      if (!REAL_RE.test(s)) real = false;
      if (!int && !real) break;
    }
    return seen ? (int ? 'int' : real ? 'real' : 'text') : 'text';
  });
}

// 新表字段名清洗：空白折叠、非法字符下划线、纯数字开头加 c、去重
function cleanName(h, i) {
  let s = String(h == null ? '' : h).trim();
  if (!s) s = '列' + (i + 1);
  s = s
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'c$1');
  return s || '列' + (i + 1);
}
function dedupeNames(names) {
  const seen = new Set();
  return names.map((n) => {
    let k = n;
    let i = 2;
    while (seen.has(k)) k = `${n}_${i++}`;
    seen.add(k);
    return k;
  });
}

// 字段映射初始化：现有表按名称精确/忽略大小写自动匹配；新建表用清洗后的源字段名
function buildMaps(header, kinds, meta) {
  if (meta && meta.length) {
    const lower = new Map(meta.map((m) => [String(m.name).toLowerCase(), m.name]));
    return header.map((h, i) => {
      const hit = meta.find((m) => m.name === h) || lower.get(String(h).toLowerCase());
      return { src: h, kind: kinds[i], dst: hit ? hit.name : '', dstType: hit ? hit.dataType || '' : '' };
    });
  }
  return dedupeNames(header.map((h, i) => cleanName(h, i))).map((dst, i) => ({ src: header[i], kind: kinds[i], dst, dstType: '' }));
}

export default function ImportWizard({ state, conns, onClose, onChanged }) {
  const { connId, db, schema } = state;
  const conn = (conns || []).find((c) => c.id === connId) || {};
  const isPg = conn.type === 'postgres';
  const isMs = conn.type === 'mssql';
  const isOra = conn.type === 'oracle';
  // schema 兜底与数据传输向导同规则（pg public / mssql dbo / oracle 大写）
  const schemaName = isPg ? schema || 'public' : isMs ? schema || 'dbo' : isOra ? (schema || '').toUpperCase() : null;

  const [step, setStep] = useState(0);
  const [file, setFile] = useState('');
  const [format, setFormat] = useState('');
  const [header, setHeader] = useState([]);
  const [rows, setRows] = useState([]);
  const [headerRow, setHeaderRow] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState('');
  const [mode, setMode] = useState(state.mode === 'table' && state.table ? 'table' : 'new');
  const [newName, setNewName] = useState('');
  const [tables, setTables] = useState([]);
  const [tblLoading, setTblLoading] = useState(false);
  const [target, setTarget] = useState(state.mode === 'table' && state.table ? state.table : '');
  const [tMeta, setTMeta] = useState([]);
  const [maps, setMaps] = useState([]);
  const [nullEmpty, setNullEmpty] = useState(true);
  const [running, setRunning] = useState(false);
  const [doneN, setDoneN] = useState(0);
  const [totalN, setTotalN] = useState(0);
  const [errMsg, setErrMsg] = useState('');
  const [finished, setFinished] = useState(false);
  const cancelRef = useRef(false);

  const kinds = useMemo(() => inferKinds(header, rows), [header, rows]);

  const doParse = async (f = file, hr = headerRow) => {
    const p = String(f || '').trim();
    if (!p) {
      message.warning('请先选择文件或输入路径');
      return;
    }
    setParsing(true);
    setParseErr('');
    try {
      const r = await impApi.parse(p);
      let hd = r.header;
      let rs = r.rows;
      if (r.format === 'csv' && !hr) {
        // 首行不是字段名：源首行并入数据，字段名用 列1..N
        hd = Array.from({ length: r.header.length }, (_, i) => `列${i + 1}`);
        rs = [r.header, ...r.rows];
      }
      setFormat(r.format);
      setHeader(hd);
      setRows(rs);
      setTotalN(rs.length);
      setFinished(false);
      setDoneN(0);
      setErrMsg('');
    } catch (e) {
      setParseErr(e.message || String(e));
      setFormat('');
      setHeader([]);
      setRows([]);
      setTotalN(0);
    } finally {
      setParsing(false);
    }
  };

  const chooseFile = async () => {
    const f = await pickFile({
      title: '选择要导入的文件（CSV 首行为表头；JSON 为对象数组）',
      filters: [
        { name: 'CSV / JSON', extensions: ['csv', 'txt', 'json'] },
      ],
    });
    if (!f) return;
    setFile(f);
    doParse(f);
  };

  // 目标库的表清单（进入目标步骤前后都可用：新建表时用于重名校验）
  useEffect(() => {
    if (!connId) return undefined;
    let alive = true;
    setTblLoading(true);
    dbApi(connId, 'tables', { db, schema })
      .then((t) => { if (alive) setTables(Array.isArray(t) ? t : []); })
      .catch(() => { if (alive) setTables([]); })
      .finally(() => { if (alive) setTblLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, schema]);

  // 现有表的列元数据（映射的自动匹配 + 数值列类型转换依据）
  useEffect(() => {
    if (mode !== 'table' || !target) {
      setTMeta([]);
      return undefined;
    }
    let alive = true;
    dbApi(connId, 'columns', { db, schema, table: target })
      .then((m) => { if (alive) setTMeta(Array.isArray(m) ? m : []); })
      .catch(() => { if (alive) setTMeta([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, target]);

  // 解析结果 / 模式 / 目标表变化时重建映射
  useEffect(() => {
    setMaps(buildMaps(header, kinds, mode === 'table' ? tMeta : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header, kinds, mode, tMeta]);

  const useMaps = maps.filter((m) => m.dst);
  const nameOk = !!newName.trim() && /^[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5#$]*$/.test(newName.trim());
  const nameDup = mode === 'new' && !!newName.trim() && tables.includes(newName.trim());
  const canNext =
    step === 0 ? header.length > 0 && !parseErr
      : step === 1 ? (mode === 'new' ? nameOk && !nameDup : !!target)
        : step === 2 ? useMaps.length > 0
          : false;

  const runImport = async () => {
    if (!useMaps.length) return;
    const tbl = mode === 'new' ? newName.trim() : target;
    const cols = useMaps.map((m) => m.dst);
    // 数值目标列：新建表按推断族；现有表按列类型。数值列的合法数字串转 Number 再绑定
    const numericDst = new Set(
      useMaps
        .filter((m) => (mode === 'new' ? m.kind !== 'text' : NUM_TYPE.test(m.dstType || '')))
        .map((m) => m.dst)
    );
    const srcIdx = useMaps.map((m) => header.indexOf(m.src));
    const conv = rows.map((r) =>
      useMaps.map((m, j) => {
        let v = r[srcIdx[j]];
        if (v === '' || v === undefined) v = nullEmpty ? null : '';
        if (v !== null && v !== '' && numericDst.has(m.dst) && typeof v !== 'number') {
          const s = String(v).trim();
          if (REAL_RE.test(s)) v = Number(s);
        }
        return v;
      })
    );
    setRunning(true);
    setFinished(false);
    setDoneN(0);
    setTotalN(conv.length);
    setErrMsg('');
    cancelRef.current = false;
    let done = 0;
    try {
      if (mode === 'new') {
        await dbApi(connId, 'createTable', {
          db,
          schema: schemaName,
          name: tbl,
          cols: useMaps.map((m) => ({
            name: m.dst,
            dataType: KIND_TYPE[m.kind],
            length: '',
            scale: '',
            nullable: true,
            pk: false,
            autoInc: false,
            defaultValue: '',
            comment: `导入自 ${String(file).split(/[\\/]/).pop() || '文件'}`,
            origName: m.dst,
          })),
        });
      }
      const BATCH = 500;
      for (let i = 0; i < conv.length; i += BATCH) {
        if (cancelRef.current) break;
        await dbApi(connId, 'insertRows', { db, schema: schemaName, table: tbl, columns: cols, rows: conv.slice(i, i + BATCH) });
        done = Math.min(i + BATCH, conv.length);
        setDoneN(done);
      }
      if (cancelRef.current) {
        setErrMsg(`已取消（已写入 ${done} 行）`);
      } else {
        setFinished(true);
        message.success(`导入完成：${conv.length} 行 → ${tbl}`);
        if (onChanged) onChanged();
      }
    } catch (e) {
      setErrMsg(`写入失败（已写入 ${done} 行）：${e.message || e}`);
    } finally {
      setRunning(false);
    }
  };

  const tblName = mode === 'new' ? newName.trim() : target;

  const previewCols = header.slice(0, 12).map((h, i) => ({
    key: String(i),
    title: h,
    dataIndex: i,
    ellipsis: true,
    width: 150,
    render: (v) => <span style={{ color: v == null ? '#bbb' : undefined }}>{fmt(v)}</span>,
  }));
  const previewData = rows.slice(0, 12).map((r, i) => {
    const o = { key: String(i) };
    header.forEach((_, j) => { o[j] = r[j]; });
    return o;
  });

  const updMap = (i, patch) => setMaps((p) => p.map((x, xi) => (xi === i ? { ...x, ...patch } : x)));

  const mapColumns = [
    { title: '源字段', dataIndex: 'src', key: 'src', width: 170, ellipsis: true },
    {
      title: mode === 'new' ? '类型（可改）' : '目标类型',
      dataIndex: 'kind',
      key: 'kind',
      width: 110,
      render: (_, m) =>
        mode === 'new' ? (
          <Select
            size="small"
            style={{ width: 92 }}
            value={m.kind}
            disabled={running}
            options={Object.keys(KIND_TYPE).map((k) => ({ value: k, label: KIND_CN[k] }))}
            onChange={(v) => updMap(m.__i, { kind: v })}
          />
        ) : (
          <span className="ctx">{m.dstType || '—'}</span>
        ),
    },
    {
      title: '目标字段',
      dataIndex: 'dst',
      key: 'dst',
      width: 200,
      render: (_, m) =>
        mode === 'new' ? (
          <Input
            size="small"
            value={m.dst}
            disabled={running}
            onChange={(e) => updMap(m.__i, { dst: e.target.value })}
          />
        ) : (
          <Select
            size="small"
            style={{ width: 180 }}
            showSearch
            optionFilterProp="label"
            placeholder="不导入"
            value={m.dst || undefined}
            disabled={running}
            allowClear
            options={tMeta.map((c) => ({ value: c.name, label: c.name }))}
            onChange={(v) => updMap(m.__i, { dst: v || '' })}
          />
        ),
    },
    {
      title: '首行示例',
      key: 'sample',
      ellipsis: true,
      render: (_, m) => {
        const v = rows.length ? rows[0][header.indexOf(m.src)] : '';
        return <span style={{ color: v == null ? '#bbb' : undefined }}>{fmt(v)}</span>;
      },
    },
  ];

  const footerBtns = [];
  if (step < 3) {
    footerBtns.push(
      <Button key="cancel" onClick={onClose}>取消</Button>
    );
    if (step > 0) footerBtns.push(<Button key="prev" onClick={() => setStep(step - 1)}>上一步</Button>);
    footerBtns.push(
      <Button key="next" type="primary" disabled={!canNext || parsing} onClick={() => setStep(step + 1)}>下一步</Button>
    );
  } else if (running) {
    footerBtns.push(
      <Button key="stop" danger onClick={() => { cancelRef.current = true; }}>取消导入</Button>
    );
  } else if (finished || errMsg) {
    footerBtns.push(
      <Button key="again" onClick={() => { setStep(0); setFinished(false); setErrMsg(''); setDoneN(0); }}>再次导入</Button>,
      <Button key="close2" type="primary" onClick={onClose}>关闭</Button>
    );
  } else {
    footerBtns.push(
      <Button key="prev3" onClick={() => setStep(2)}>上一步</Button>,
      <Button key="run" type="primary" icon={<FileSearchOutlined />} onClick={runImport}>开始导入</Button>
    );
  }

  return (
    <Modal
      open
      title={`导入向导 · ${conn.name || ''}${db ? ' · ' + db : ''}${schema ? ' · ' + schema : ''}`}
      width={780}
      footer={footerBtns}
      closable={!running}
      maskClosable={false}
      onCancel={() => { if (!running) onClose(); }}
      destroyOnClose
    >
      <Steps
        size="small"
        current={step}
        items={[{ title: '文件' }, { title: '目标' }, { title: '字段映射' }, { title: '执行' }]}
        style={{ marginBottom: 16 }}
      />
      {step === 0 && (
        <div>
          <div className="imp-file-row">
            <Input
              placeholder="文件路径（CSV 首行为表头；JSON 为对象数组）"
              value={file}
              onChange={(e) => setFile(e.target.value)}
              onPressEnter={() => doParse()}
              disabled={parsing}
            />
            <Button icon={<FolderOpenOutlined />} disabled={parsing} onClick={chooseFile}>选择文件…</Button>
            <Button type="primary" loading={parsing} icon={<FileSearchOutlined />} onClick={() => doParse()}>解析预览</Button>
          </div>
          {format === 'csv' && (
            <div style={{ marginTop: 8 }}>
              <Checkbox
                checked={headerRow}
                onChange={(e) => {
                  setHeaderRow(e.target.checked);
                  if (file) doParse(file, e.target.checked);
                }}
              >
                首行为字段名
              </Checkbox>
            </div>
          )}
          {parseErr && <div className="imp-err">解析失败：{parseErr}</div>}
          {header.length > 0 && (
            <div>
              <div className="imp-stat">
                {format === 'json' ? 'JSON' : 'CSV'} · {header.length} 列 · {rows.length} 行（预览前 12 行，导入时全部写入）
              </div>
              <div className="imp-preview">
                <Table
                  size="small"
                  className="imp-map"
                  columns={previewCols}
                  dataSource={previewData}
                  pagination={false}
                  scroll={{ y: 200, x: 'max-content' }}
                />
              </div>
            </div>
          )}
        </div>
      )}
      {step === 1 && (
        <div>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} disabled={running}>
            <Radio value="new">新建表</Radio>
            <Radio value="table">现有表</Radio>
          </Radio.Group>
          {mode === 'new' ? (
            <div style={{ marginTop: 12 }}>
              <Input
                autoFocus
                placeholder="新表名，如 import_orders"
                style={{ width: 280 }}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              {nameDup && <div className="imp-err">同名表已存在，请换一个名字</div>}
              <div className="imp-hint">
                列类型按数据推断：整数 → BIGINT、小数 → DOUBLE、其余 → TEXT（各数据库自动映射），下一步可逐列调整。
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="选择目标表"
                style={{ width: 280 }}
                value={target || undefined}
                loading={tblLoading}
                options={tables.map((t) => ({ value: t, label: t }))}
                onChange={setTarget}
                notFoundContent={tblLoading ? '加载中…' : '暂无表'}
              />
              <div className="imp-hint">
                {tMeta.length ? `目标表 ${tMeta.length} 列；名称相同的字段自动映射，其余可手动指定或跳过。` : '选择表后自动按名称映射。'}
              </div>
            </div>
          )}
        </div>
      )}
      {step === 2 && (
        <div className="imp-preview">
          <Table
            size="small"
            className="imp-map"
            columns={mapColumns}
            dataSource={maps.map((m, i) => ({ ...m, __i: i, key: i }))}
            pagination={false}
            scroll={{ y: 260 }}
            locale={{ emptyText: '请先解析文件' }}
          />
          <div className="imp-hint">
            共 {header.length} 个源字段，已映射 {useMaps.length} 个；目标字段留空（选「不导入」）则跳过该列。
          </div>
        </div>
      )}
      {step === 3 && (
        <div>
          <div className="imp-stat">
            目标：{mode === 'new' ? `新建表 ${tblName}` : `现有表 ${tblName}`} · 已映射 {useMaps.length} 字段 · 共 {rows.length} 行
          </div>
          <div className="imp-hint">
            分批参数化写入（每批 500 行、逐批事务），中途失败会停在出错批次并报告已写入行数。
            <Checkbox
              style={{ marginLeft: 12 }}
              checked={nullEmpty}
              onChange={(e) => setNullEmpty(e.target.checked)}
            >
              空单元格作为 NULL
            </Checkbox>
          </div>
          {(running || doneN > 0 || errMsg) && (
            <Progress
              percent={Math.round((doneN * 100) / Math.max(1, totalN))}
              status={errMsg ? 'exception' : finished ? 'success' : 'active'}
            />
          )}
          {errMsg && <div className="imp-err">{errMsg}</div>}
          {finished && <div className="imp-ok">导入完成：{doneN} 行已写入「{tblName}」，刷新数据页（F5）可见。</div>}
        </div>
      )}
    </Modal>
  );
}
