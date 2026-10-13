import React, { useEffect, useState } from 'react';
import { Button, Checkbox, Input, Modal, Select, message } from 'antd';
import { CaretRightOutlined, FolderOpenOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { backupFiles, dbApi, pickFile, runSqlFile } from '../../api';

const TYPE_LABEL = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite', mssql: 'SQL Server', oracle: 'Oracle' };
const RELATIONAL = ['mysql', 'mariadb', 'postgres', 'sqlite', 'mssql', 'oracle'];

function fmtSize(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}
function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

// 运行 SQL 文件（还原备份）：选 .sql 脚本 + 目标连接 → 主进程逐句原样执行（与查询页同一条 query 分发）
export default function RestoreTab({ conns, preset, onConnect, onStatus, onChanged }) {
  const [file, setFile] = useState((preset && preset.file) || '');
  const [dir, setDir] = useState('');
  const [fileOpts, setFileOpts] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [connId, setConnId] = useState((preset && preset.connId) || '');
  const [db, setDb] = useState((preset && preset.db) || '');
  const [schema, setSchema] = useState((preset && preset.schema) || '');
  const [root, setRoot] = useState(null); // {dbs:[], schemas:[]}，null=未加载
  const [continueOnErr, setContinueOnErr] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // {total, ok, errors:[{sql,error}], elapsed, file}
  const [logs, setLogs] = useState([]);

  const loadFiles = async (d) => {
    setLoadingFiles(true);
    try {
      const list = await backupFiles(d || undefined);
      setDir(list.length ? list[0].dir : d || '');
      setFileOpts(list);
    } catch (e) {
      message.error('读取备份目录失败：' + e.message);
    } finally {
      setLoadingFiles(false);
    }
  };

  useEffect(() => {
    loadFiles('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (preset && preset.connId) {
      setConnId(preset.connId);
      setDb(preset.db || '');
      setSchema(preset.schema || '');
    }
    if (preset && preset.file) setFile(preset.file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const loadRoot = async (id) => {
    const conn = conns.find((c) => c.id === id);
    if (!conn || !RELATIONAL.includes(conn.type)) {
      setRoot({ dbs: [], schemas: [] });
      return;
    }
    try {
      await onConnect(conn);
      const r = await dbApi(id, 'treeRoot');
      setRoot({
        dbs: r.filter((n) => n.type === 'db').map((n) => n.name),
        schemas: r.filter((n) => n.type === 'schema').map((n) => n.name),
      });
    } catch (e) {
      setRoot({ dbs: [], schemas: [] });
      message.error('读取库列表失败：' + e.message);
    }
  };

  useEffect(() => {
    setDb('');
    setSchema('');
    if (connId) loadRoot(connId);
    else setRoot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  const conn = conns.find((c) => c.id === connId);
  const type = conn ? conn.type : '';
  const needDb = ['mysql', 'mariadb', 'mssql'].includes(type);
  const canRun = !!file && !!connId && (!needDb || !!db) && !running;

  const browse = async () => {
    const p = await pickFile({ title: '选择 SQL 文件', filters: [{ name: 'SQL 脚本', extensions: ['sql'] }] });
    if (!p) return;
    setFile(p);
    const name = String(p).split(/[\\/]/).pop();
    setFileOpts((prev) => (prev.some((x) => x.file === p) ? prev : [{ file: p, name, size: 0, mtime: 0, dir: '' }, ...prev]));
  };

  const run = () => {
    const name = String(file).split(/[\\/]/).pop();
    Modal.confirm({
      title: '运行 SQL 文件并写入目标？',
      content: `将把「${name}」的全部语句在目标连接上原样执行（可能创建/覆盖/删除数据）。`,
      okText: '运行',
      okType: 'danger',
      cancelText: '取消',
      transitionName: '',
      maskTransitionName: '',
      onOk: async () => {
        setRunning(true);
        setLogs([]);
        const addLog = (k, t) => setLogs((p) => [...p, { k, t }]);
        try {
          const r = await runSqlFile({ connId, db: db || '', schema: schema || '', file, stopOnError: !continueOnErr });
          setResult({ ...r, file });
          addLog(r.errors.length ? 'err' : 'ok', `${name}：语句 ${r.total} · 成功 ${r.ok} · 失败 ${r.errors.length} · 耗时 ${(r.elapsed / 1000).toFixed(2)}s`);
          r.errors.slice(0, 8).forEach((x, i) => addLog('err', `[${i + 1}] ${x.error} ← ${x.sql.slice(0, 80)}`));
          if (r.errors.length > 8) addLog('err', `……另有 ${r.errors.length - 8} 条错误`);
          try { console.log(`DH-RESTORE run ok=${r.ok} err=${r.errors.length} total=${r.total} file=${name}`); } catch {}
          setRunning(false);
          if (!r.errors.length) message.success(`运行完成：${r.ok} 条语句全部成功`);
          else message.warning(`运行完成：成功 ${r.ok}、失败 ${r.errors.length}`);
          onStatus(`运行 SQL 文件：${name} → 成功 ${r.ok} / 失败 ${r.errors.length}`);
        } catch (e) {
          setRunning(false);
          addLog('err', '运行失败：' + e.message);
          try { console.log(`DH-RESTORE fail file=${name} err=${e.message}`); } catch {}
          message.error('运行失败：' + e.message);
          return;
        }
        onChanged(); // 刷新树（新表/新数据立即可见）
      },
    });
  };

  return (
    <div style={{ padding: '8px 12px', height: '100%', overflow: 'auto' }} data-dh-restore="root">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 46%', minWidth: 260 }} data-dh-restore="file">
          <div style={{ marginBottom: 4, fontWeight: 600 }}>SQL 文件（备份目录）</div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择 .sql 文件"
            value={file || undefined}
            onChange={setFile}
            showSearch
            optionFilterProp="label"
            loading={loadingFiles}
            notFoundContent={dir ? '目录中没有 .sql 文件' : '（目录不可用，可点“浏览”选择文件）'}
            options={fileOpts.map((f) => ({ value: f.file, label: `${f.name}（${fmtSize(f.size)}${f.mtime ? ' · ' + fmtTime(f.mtime) : ''}）` }))}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
            <Button size="small" icon={<SearchOutlined />} onClick={browse}>
              浏览…
            </Button>
            <Button size="small" icon={<ReloadOutlined />} loading={loadingFiles} onClick={() => loadFiles(dir)}>
              刷新目录
            </Button>
            <span style={{ fontSize: 12, color: '#999', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dir || undefined}>
              {dir || '默认：userData/backups'}
            </span>
          </div>
        </div>
        <div style={{ flex: '1 1 42%', minWidth: 240 }} data-dh-restore="conn">
          <div style={{ marginBottom: 4, fontWeight: 600 }}>目标</div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择连接"
            value={connId || undefined}
            onChange={setConnId}
            showSearch
            optionFilterProp="label"
            options={conns.filter((c) => RELATIONAL.includes(c.type)).map((c) => ({ value: c.id, label: `${c.name}（${TYPE_LABEL[c.type]}）` }))}
          />
          {type === 'sqlite' && <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>SQLite：脚本作用于整个库文件</div>}
          {needDb && (
            <div style={{ marginTop: 8 }} data-dh-restore="db">
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
          {type === 'postgres' && (
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
          {(type === 'mssql' || type === 'oracle') && (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 4, fontSize: 12 }}>schema（{type === 'mssql' ? '默认 dbo' : '=用户名，大写'}）：</div>
              <Input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder={type === 'mssql' ? 'dbo' : '例如 SCOTT'} />
            </div>
          )}
        </div>
        <div style={{ paddingTop: 22 }}>
          <Button type="primary" icon={<CaretRightOutlined />} loading={running} disabled={!canRun} onClick={run} data-dh-restore="run">
            运行
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '12px 0 0' }} data-dh-restore="opts">
        <Checkbox checked={continueOnErr} onChange={(e) => setContinueOnErr(e.target.checked)}>
          遇到错误时继续
        </Checkbox>
        <span style={{ fontSize: 12, color: '#999' }}>（不勾选 = 第一条出错的语句后立即停止）</span>
      </div>

      {result && (
        <div style={{ marginTop: 10 }} data-dh-restore="result">
          <div style={{ display: 'flex', gap: 14, fontSize: 13, marginBottom: 6 }}>
            <span>语句 <b>{result.total}</b></span>
            <span>成功 <b style={{ color: '#389e0d' }}>{result.ok}</b></span>
            <span>失败 <b style={{ color: result.errors.length ? '#cf1322' : '#bbb' }}>{result.errors.length}</b></span>
            <span>耗时 {(result.elapsed / 1000).toFixed(2)}s</span>
            <span style={{ color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={result.file}>
              {String(result.file).split(/[\\/]/).pop()}
            </span>
          </div>
          {result.errors.length > 0 && (
            <div style={{ border: '1px solid #ffd6d6', background: '#fff2f0', borderRadius: 4, padding: '6px 10px', fontSize: 12, fontFamily: 'Consolas, monospace', maxHeight: 180, overflow: 'auto' }}>
              {result.errors.slice(0, 20).map((x, i) => (
                <div key={i} style={{ color: '#cf1322', marginBottom: 4 }} data-dh-restore="errline">
                  <div>[{i + 1}] {x.error}</div>
                  <div style={{ color: '#999', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{x.sql}</div>
                </div>
              ))}
              {result.errors.length > 20 && <div style={{ color: '#999' }}>……另有 {result.errors.length - 20} 条错误</div>}
            </div>
          )}
        </div>
      )}
      {logs.length > 0 && (
        <div data-dh-restore="logs" style={{ marginTop: 8, background: '#fafafa', border: '1px solid #eee', borderRadius: 4, padding: '6px 8px', fontSize: 12, fontFamily: 'Consolas, monospace', maxHeight: 130, overflow: 'auto' }}>
          {logs.map((x, i) => (
            <div key={i} data-dh-restore-log={x.k} style={{ color: x.k === 'err' ? '#cf1322' : '#389e0d' }}>
              {x.t}
            </div>
          ))}
        </div>
      )}
      <div style={{ color: '#999', fontSize: 12, marginTop: 10 }}>
        还原/执行 .sql 脚本：语句按目标方言逐句原样执行（不做任何改写），默认遇到错误继续；脚本内容会直接修改目标库，请先确认来源可靠。SQLite 目标执行后立即落盘。
      </div>
    </div>
  );
}
