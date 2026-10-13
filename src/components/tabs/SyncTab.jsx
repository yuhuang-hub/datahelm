import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Progress, Select, Table, Tag, message } from 'antd';
import { CaretRightOutlined, CopyOutlined, SwapOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { copyText, dbApi, dbSyncCompare, subscribeSyncProgress } from '../../api';

const TYPE_LABEL = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite', mssql: 'SQL Server', oracle: 'Oracle' };
const RELATIONAL = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mssql', 'oracle'];
const STATUS_TAG = {
  create: { color: 'green', text: '新建' },
  diff: { color: 'orange', text: '有差异' },
  extra: { color: 'red', text: '目标独有' },
  same: { color: 'default', text: '一致' },
};
// 比较请求关联 ID 自增序号（仅用于隔离并发比较的进度事件，非加密用途）
let SYNC_REQ_SEQ = 1;

// 结构同步：源/目标 → 比较表结构差异（列/索引/唯一键/外键/检查）→ 生成 DDL → 可应用
// 比较在主进程完成（跨方言类型映射与数据传输同源）；应用复用驱动的 createTable/applyAlter/dropTable
export default function SyncTab({ conns, preset, onConnect, onStatus, onChanged }) {
  const [srcId, setSrcId] = useState((preset && preset.connId) || '');
  const [srcDb, setSrcDb] = useState((preset && preset.db) || '');
  const [srcSchema, setSrcSchema] = useState((preset && preset.schema) || '');
  const [dstId, setDstId] = useState('');
  const [dstDb, setDstDb] = useState('');
  const [dstSchema, setDstSchema] = useState('');
  const [srcRoot, setSrcRoot] = useState(null); // {dbs:[], schemas:[]}，null=未加载
  const [dstRoot, setDstRoot] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [result, setResult] = useState(null); // {items, srcType, dstType, targetCtx}
  const [prog, setProg] = useState(null); // 比较进度：{table,index,total} → 完成态 {done:true,total}
  const [sel, setSel] = useState(() => new Set());
  const [applying, setApplying] = useState(false);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    if (preset && preset.connId) {
      setSrcId(preset.connId);
      setSrcDb(preset.db || '');
      setSrcSchema(preset.schema || '');
    }
  }, [preset]);

  const loadRoot = async (id, isSrc) => {
    const conn = conns.find((c) => c.id === id);
    if (!conn || !RELATIONAL.includes(conn.type)) {
      if (isSrc) setSrcRoot({ dbs: [], schemas: [] });
      else setDstRoot({ dbs: [], schemas: [] });
      return;
    }
    try {
      await onConnect(conn);
      const root = await dbApi(id, 'treeRoot');
      const dbs = root.filter((n) => n.type === 'db').map((n) => n.name);
      const schemas = root.filter((n) => n.type === 'schema').map((n) => n.name);
      if (isSrc) setSrcRoot({ dbs, schemas });
      else setDstRoot({ dbs, schemas });
    } catch (e) {
      if (isSrc) setSrcRoot({ dbs: [], schemas: [] });
      else setDstRoot({ dbs: [], schemas: [] });
      message.error('读取库列表失败：' + e.message);
    }
  };

  useEffect(() => {
    setSrcDb('');
    setSrcSchema('');
    if (srcId) loadRoot(srcId, true);
    else setSrcRoot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId]);
  useEffect(() => {
    setDstDb('');
    setDstSchema('');
    if (dstId) loadRoot(dstId, false);
    else setDstRoot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dstId]);

  const srcConn = conns.find((c) => c.id === srcId);
  const dstConn = conns.find((c) => c.id === dstId);
  const srcType = srcConn ? srcConn.type : '';
  const dstType = dstConn ? dstConn.type : '';
  const canCompare =
    !!srcId && !!dstId && !comparing &&
    (!['mysql', 'mariadb', 'mssql'].includes(srcType) || !!srcDb) &&
    (!['mysql', 'mariadb', 'mssql'].includes(dstType) || !!dstDb);

  const compare = async () => {
    setComparing(true);
    // 进度订阅：reqId 隔离并发比较（毫秒时间戳+模块自增，纯关联 ID 非加密用途）；
    // 主进程每张表开工前回推 {table,index,total}
    const reqId = 'sr' + Date.now().toString(36) + String(SYNC_REQ_SEQ++);
    let settled = false;
    let lastTotal = 0;
    setProg({ table: '', index: 0, total: 0, done: false });
    const off = subscribeSyncProgress((p) => {
      if (!p || p.kind !== 'struct' || p.reqId !== reqId) return;
      try { console.log('DH-SYNC-PROG k=struct t=' + (p.table || '') + ' i=' + (p.index || 0) + ' n=' + (p.total || 0)); } catch {}
      // invoke 回复与 send 事件走不同 IPC 通道、到达顺序无保证：完成后的迟到事件只记日志不再动 UI
      if (settled) return;
      lastTotal = p.total || lastTotal;
      setProg({ table: p.table || '', index: p.index || 0, total: p.total || 0, done: false });
    });
    try {
      const r = await dbSyncCompare({ srcId, srcDb, srcSchema, dstId, dstDb, dstSchema, reqId });
      settled = true;
      setResult(r);
      const fin = lastTotal || r.items.length;
      setProg({ table: '', index: fin, total: fin, done: true });
      const nCreate = r.items.filter((x) => x.status === 'create').length;
      const nDiff = r.items.filter((x) => x.status === 'diff').length;
      const nExtra = r.items.filter((x) => x.status === 'extra').length;
      const nSame = r.items.filter((x) => x.status === 'same').length;
      setSel(new Set(r.items.filter((x) => x.status === 'create' || x.status === 'diff').map((x) => x.table)));
      onStatus(`结构比较完成：新建 ${nCreate}、差异 ${nDiff}、目标独有 ${nExtra}、一致 ${nSame}`);
      try { console.log(`DH-SYNC compare ok create=${nCreate} diff=${nDiff} extra=${nExtra} same=${nSame}`); } catch {}
      if (!nCreate && !nDiff && !nExtra) message.success('两边结构完全一致');
    } catch (e) {
      settled = true;
      message.error('比较失败：' + e.message);
      setResult(null);
      setProg(null);
    } finally {
      // invoke 回复可与 send 事件乱序：最后几条进度事件可能晚于回复到达——
      // 延迟退订让迟到的尾部事件仍能落日志（UI 已由 settled 门保护）
      setTimeout(() => { try { off(); } catch {} }, 400);
      setComparing(false);
    }
  };

  const scriptText = useMemo(() => {
    if (!result) return '';
    const parts = [];
    for (const it of result.items) {
      if (!sel.has(it.table)) continue;
      const head = `-- ${it.table}（${STATUS_TAG[it.status].text}）`;
      if (it.status === 'extra') parts.push(`${head}\n-- 应用时删除目标中的该表`);
      else parts.push(`${head}\n${it.ddl || '-- （未能生成脚本）'}`);
    }
    return parts.join('\n\n');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, sel]);

  const apply = async () => {
    if (!result || !sel.size) return;
    const chosen = result.items.filter((x) => sel.has(x.table));
    const hasDrop = chosen.some((x) => x.status === 'extra');
    Modal.confirm({
      title: `应用 ${chosen.length} 项变更到目标？`,
      content: hasDrop
        ? '将在目标库执行所选结构变更，其中包含删除表操作（不可恢复）。'
        : '将在目标库执行所选结构变更（新建表 / 修改列与索引等）。',
      okText: '应用',
      okType: 'danger',
      cancelText: '取消',
      transitionName: '',
      maskTransitionName: '',
      onOk: async () => {
        setApplying(true);
        setLogs([]);
        const addLog = (k, t) => setLogs((p) => [...p, { k, t }]);
        let okN = 0;
        let errN = 0;
        try {
          await onConnect(dstConn);
        } catch {}
        for (let i = 0; i < chosen.length; i++) {
          const it = chosen[i];
          const tag = `[${i + 1}/${chosen.length}] ${it.table}`;
          try {
            if (it.status === 'create') {
              const spec = { ...it.createSpec, fkeysAfter: dstType === 'sqlite' ? it.createSpec.fkeysAfter : [] };
              await dbApi(dstId, 'createTable', spec);
              if (it.fkSpec) await dbApi(dstId, 'applyAlter', it.fkSpec);
              okN += 1;
              addLog('ok', `${tag}：已建表（${spec.cols.length} 列${it.fkSpec ? ' + 外键补挂' : ''}）`);
            } else if (it.status === 'diff') {
              const r = await dbApi(dstId, 'applyAlter', it.spec);
              okN += 1;
              addLog('ok', `${tag}：已执行 ${r.executed} 条语句`);
            } else if (it.status === 'extra') {
              await dbApi(dstId, 'dropTable', { db: result.targetCtx.db, schema: result.targetCtx.schema, table: it.table });
              okN += 1;
              addLog('ok', `${tag}：已删除`);
            }
          } catch (e) {
            errN += 1;
            addLog('err', `${tag}：失败：${e.message}`);
          }
        }
        addLog(errN ? 'err' : 'ok', `结束：成功 ${okN}、失败 ${errN}`);
        try { console.log(`DH-SYNC apply done ok=${okN} err=${errN}`); } catch {}
        setApplying(false);
        if (errN === 0) message.success(`结构同步完成：${okN} 项`);
        onChanged();
        await compare(); // 重新比较刷新状态（同步成功后差异应归零）
      },
    });
  };

  const sidePanel = (title, connId, setConnId, type, db, setDb, schema, setSchema, root) => {
    const conn = conns.find((c) => c.id === connId);
    const t = conn ? conn.type : '';
    const needDb = ['mysql', 'mariadb', 'mssql'].includes(t);
    return (
      <div style={{ flex: '1 1 42%', minWidth: 220 }} data-dh-sync={title}>
        <div style={{ marginBottom: 4, fontWeight: 600 }}>{title}</div>
        <Select
          style={{ width: '100%' }}
          placeholder="选择连接"
          value={connId || undefined}
          onChange={setConnId}
          showSearch
          optionFilterProp="label"
          options={conns.filter((c) => RELATIONAL.includes(c.type)).map((c) => ({ value: c.id, label: `${c.name}（${TYPE_LABEL[c.type]}）` }))}
        />
        {t === 'sqlite' && <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>SQLite：同步整个库文件</div>}
        {needDb && (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 4, fontSize: 12 }}>数据库：</div>
            <Select
              style={{ width: '100%' }}
              placeholder="选择数据库"
              value={db || undefined}
              onChange={setDb}
              showSearch
              optionFilterProp="label"
              loading={!root}
              options={(root ? root.dbs : []).map((n) => ({ value: n, label: n }))}
            />
          </div>
        )}
        {t === 'postgres' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 4, fontSize: 12 }}>schema（默认 public）：</div>
            <Select
              style={{ width: '100%' }}
              placeholder="public"
              value={schema || undefined}
              onChange={setSchema}
              showSearch
              optionFilterProp="label"
              loading={!root}
              options={(root ? root.schemas : []).map((n) => ({ value: n, label: n }))}
            />
          </div>
        )}
        {t === 'mssql' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 4, fontSize: 12 }}>schema（默认 dbo）：</div>
            <Input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="dbo" />
          </div>
        )}
        {t === 'oracle' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 4, fontSize: 12 }}>schema（=用户名，大写）：</div>
            <Input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="例如 SCOTT" />
          </div>
        )}
      </div>
    );
  };

  const columns = [
    { title: '表', dataIndex: 'table', key: 'table', width: 180, ellipsis: true },
    {
      title: '状态',
      key: 'status',
      width: 92,
      render: (_, r) => {
        const st = STATUS_TAG[r.status];
        return <Tag color={st.color}>{st.text}</Tag>;
      },
    },
    {
      title: '差异明细',
      key: 'changes',
      render: (_, r) =>
        r.status === 'same' ? (
          <span style={{ color: '#bbb' }}>—</span>
        ) : (
          <span style={{ fontSize: 12 }}>
            {r.changes.join('；')}
            {r.err ? <span style={{ color: '#cf1322' }}>（生成脚本失败：{r.err}）</span> : null}
          </span>
        ),
    },
  ];
  const selRows = result ? result.items.filter((x) => sel.has(x.table)) : [];
  const nCreate = selRows.filter((x) => x.status === 'create').length;
  const nDiff = selRows.filter((x) => x.status === 'diff').length;
  const nDrop = selRows.filter((x) => x.status === 'extra').length;

  return (
    <div style={{ padding: '8px 12px', height: '100%', overflow: 'auto' }} data-dh-sync="root">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {sidePanel('源', srcId, setSrcId, srcType, srcDb, setSrcDb, srcSchema, setSrcSchema, srcRoot)}
        <div style={{ paddingTop: 26 }}>
          <SwapOutlined style={{ fontSize: 18, color: '#999' }} />
        </div>
        {sidePanel('目标', dstId, setDstId, dstType, dstDb, setDstDb, dstSchema, setDstSchema, dstRoot)}
        <div style={{ paddingTop: 22 }}>
          <Button type="primary" icon={<CaretRightOutlined />} loading={comparing} disabled={!canCompare} onClick={compare} data-dh-sync="compare">
            比较
          </Button>
        </div>
      </div>

      {prog && (
        <div data-dh-sync="prog" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <Progress
            className="dh-sync-prog-bar"
            style={{ flex: '0 0 200px', margin: 0 }}
            size="small"
            status={prog.done ? 'success' : 'active'}
            percent={prog.done ? 100 : (prog.total ? Math.min(99, Math.max(2, Math.round((prog.index / prog.total) * 100))) : 2)}
          />
          <span
            data-dh-sync-prog={prog.done ? 'done' : 'live'}
            title={prog.table || ''}
            style={{ fontSize: 12, color: '#666', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {prog.done
              ? '比较完成 · ' + prog.total + ' 张表'
              : prog.table
                ? '正在比较：' + prog.table + '（' + prog.index + '/' + prog.total + '）'
                : '正在读取表清单…'}
          </span>
        </div>
      )}

      {result && (
        <>
          <Table
            size="small"
            style={{ marginTop: 10 }}
            rowKey="table"
            columns={columns}
            dataSource={result.items}
            pagination={false}
            scroll={{ y: 220 }}
            rowSelection={{
              selectedRowKeys: [...sel],
              onChange: (keys) => setSel(new Set(keys)),
              getCheckboxProps: (r) => ({ disabled: r.status === 'same' || (!r.ddl && r.status !== 'extra' && !!r.err) }),
            }}
            data-dh-sync="table"
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0 6px' }}>
            <span style={{ fontSize: 12, color: '#666' }}>
              已选 {sel.size} 项（新建 {nCreate}、修改 {nDiff}、删除 {nDrop}）· {TYPE_LABEL[result.srcType]} → {TYPE_LABEL[result.dstType]}
            </span>
            <span style={{ flex: 1 }} />
            <Button size="small" icon={<CopyOutlined />} disabled={!scriptText} onClick={() => copyText(scriptText).then(() => message.success('脚本已复制'))}>
              复制脚本
            </Button>
            <Button size="small" type="primary" danger={nDrop > 0} icon={<ThunderboltOutlined />} loading={applying} disabled={!selRows.length} onClick={apply} data-dh-sync="apply">
              应用所选
            </Button>
          </div>
          <pre
            data-dh-sync="sql"
            style={{ margin: 0, background: 'var(--dh-bg-2, #f6f8fa)', border: '1px solid #e8e8e8', borderRadius: 4, padding: '8px 10px', fontSize: 12, fontFamily: 'Consolas, monospace', maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}
          >
            {scriptText || '-- 勾选差异项后在此显示生成的 SQL'}
          </pre>
          {logs.length > 0 && (
            <div data-dh-sync="logs" style={{ marginTop: 8, background: '#fafafa', border: '1px solid #eee', borderRadius: 4, padding: '6px 8px', fontSize: 12, fontFamily: 'Consolas, monospace', maxHeight: 130, overflow: 'auto' }}>
              {logs.map((x, i) => (
                <div key={i} data-dh-sync-log={x.k} style={{ color: x.k === 'err' ? '#cf1322' : '#389e0d' }}>
                  {x.t}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div style={{ color: '#999', fontSize: 12, marginTop: 10 }}>
        结构同步比较列/索引/唯一键/外键/检查约束（不含数据与触发器/视图）；跨方言自动类型映射，自增列退化为普通整数。应用前建议先备份目标库。
      </div>
    </div>
  );
}
