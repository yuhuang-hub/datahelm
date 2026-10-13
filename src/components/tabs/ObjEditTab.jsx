import React, { useEffect, useRef, useState } from 'react';
import { Button, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import SqlEditor from '../SqlEditor';
import { dbApi } from '../../api';

const KIND_LABEL = {
  view: '视图', function: '函数', procedure: '存储过程', trigger: '触发器', event: '事件', sequence: '序列',
  synonym: '同义词', dblink: '数据库链接', type: '类型', package: '包',
};

// 按方言生成新对象模板
function template(type, kind, db, schema) {
  const g = (n) => (type === 'mysql' ? `\`${n}\`` : `"${n}"`);
  const pgSch = schema ? `"${schema}".` : '';
  const msSch = schema ? `${schema}.` : 'dbo.';
  // Oracle 特有目录对象（同义词/数据库链接/类型/包）
  if (kind === 'synonym') {
    return `CREATE OR REPLACE SYNONYM syn1 FOR ${schema ? schema + '.' : ''}t1;\n/`;
  }
  if (kind === 'dblink') {
    return `CREATE DATABASE LINK dbl1\n  CONNECT TO username IDENTIFIED BY "password"\n  USING 'ORCL';\n/`;
  }
  if (kind === 'type') {
    return `CREATE OR REPLACE TYPE t1 AS OBJECT (\n  a NUMBER,\n  b VARCHAR2(50)\n);\n/`;
  }
  if (kind === 'package') {
    return `CREATE OR REPLACE PACKAGE pkg1 AS\n  PROCEDURE p1;\nEND pkg1;\n/\nCREATE OR REPLACE PACKAGE BODY pkg1 AS\n  PROCEDURE p1 IS\n  BEGIN\n    NULL;\n  END p1;\nEND pkg1;\n/`;
  }
  if (kind === 'view') {
    if (type === 'oracle') return `CREATE OR REPLACE VIEW v1 AS\nSELECT 1 AS demo_col FROM dual;\n/`;
    if (type === 'mssql') return `CREATE VIEW ${msSch}v1 AS\nSELECT 1 AS demo_col;\nGO`;
    if (type === 'pg') return `CREATE OR REPLACE VIEW ${pgSch}v1 AS\nSELECT 1 AS demo_col;`;
    return `CREATE OR REPLACE VIEW ${g('v1')} AS\nSELECT 1 AS demo_col;`;
  }
  if (kind === 'sequence') {
    if (type === 'oracle') return `CREATE SEQUENCE seq1 START WITH 1 INCREMENT BY 1 NOCACHE;\n/`;
    return `CREATE SEQUENCE ${pgSch}seq1 START 1 INCREMENT 1;`;
  }
  if (kind === 'function') {
    if (type === 'oracle')
      return `CREATE OR REPLACE FUNCTION f1(x IN NUMBER) RETURN NUMBER IS\nBEGIN\n  RETURN x * 2;\nEND f1;\n/`;
    if (type === 'mssql')
      return `CREATE FUNCTION ${msSch}f1(@x INT)\nRETURNS INT\nAS\nBEGIN\n  RETURN @x * 2;\nEND\nGO`;
    if (type === 'pg')
      return `CREATE OR REPLACE FUNCTION ${pgSch}f1(x integer)\nRETURNS integer AS $$\nBEGIN\n  RETURN x * 2;\nEND;\n$$ LANGUAGE plpgsql;`;
    return `DELIMITER ;;\nCREATE FUNCTION f1(x INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN x * 2;\nEND;;\nDELIMITER ;`;
  }
  if (kind === 'procedure') {
    if (type === 'oracle')
      return `CREATE OR REPLACE PROCEDURE p1 AS\nBEGIN\n  NULL;\nEND p1;\n/`;
    if (type === 'mssql')
      return `CREATE PROCEDURE ${msSch}p1\nAS\nBEGIN\n  SELECT 1;\nEND\nGO`;
    if (type === 'pg')
      return `CREATE OR REPLACE PROCEDURE ${pgSch}p1()\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  NULL;\nEND;$$;`;
    return `DELIMITER ;;\nCREATE PROCEDURE p1()\nBEGIN\n  SELECT 1;\nEND;;\nDELIMITER ;`;
  }
  if (kind === 'trigger') {
    if (type === 'oracle')
      return `CREATE OR REPLACE TRIGGER trg1\nBEFORE INSERT ON t1 FOR EACH ROW\nBEGIN\n  NULL;\nEND;\n/`;
    if (type === 'mssql')
      return `CREATE TRIGGER ${msSch}trg1 ON ${msSch}t1 AFTER INSERT\nAS\nBEGIN\n  SET NOCOUNT ON;\nEND\nGO`;
    if (type === 'pg')
      return `CREATE OR REPLACE FUNCTION trg1_fn()\nRETURNS trigger AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;\n\nCREATE TRIGGER trg1 BEFORE INSERT ON t1\nFOR EACH ROW WHEN (true)\nEXECUTE FUNCTION trg1_fn();`;
    return `DELIMITER ;;\nCREATE TRIGGER trg1\nBEFORE INSERT ON t1\nFOR EACH ROW\nBEGIN\n  SET NEW.col = NEW.col;\nEND;;\nDELIMITER ;`;
  }
  if (kind === 'event') {
    return `DELIMITER ;;\nCREATE EVENT ev1\nON SCHEDULE EVERY 1 DAY\nON COMPLETION PRESERVE\nDO\nBEGIN\n  -- 定时执行的语句\n  SELECT 1;\nEND;;\nDELIMITER ;`;
  }
  return '-- 请输入 SQL';
}

// 编辑已有对象时对源码做可执行化处理
function prepareEdit(type, kind, db, schema, name, ddl) {
  let code = String(ddl || '').trim();
  if (type === 'mysql' || type === 'mariadb') {
    code = code.replace(/DEFINER=`[^`]*`@`[^`]*`/gi, '').replace(/DEFINER=\S+@\S+\s+/gi, '');
    const kindMap = { function: 'FUNCTION', procedure: 'PROCEDURE', trigger: 'TRIGGER', event: 'EVENT' };
    const k = kindMap[kind];
    if (k) {
      const full = db ? `\`${db}\`.\`${name}\`` : `\`${name}\``;
      if (kind === 'trigger' || kind === 'event') {
        return `DROP ${k} IF EXISTS ${full};\nDELIMITER ;;\n${code}\n;;\nDELIMITER ;`;
      }
      return `DROP ${k} IF EXISTS ${full};\nDELIMITER ;;\n${code}\n;;\nDELIMITER ;`;
    }
    return code + (code.endsWith(';') ? '' : ';');
  }
  if (type === 'pg') {
    if (kind === 'trigger') {
      return `DROP TRIGGER IF EXISTS ${schema ? `"${schema}".` : ''}"${name}" ON ${schema ? `"${schema}".` : ''}"<表名>";\n${code}`;
    }
    return code.endsWith(';') ? code : code + ';';
  }
  if (type === 'mssql') {
    const kindMap = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', view: 'VIEW' };
    const k = kindMap[kind];
    const full = `${schema || 'dbo'}.${name}`;
    return k ? `DROP ${k} IF EXISTS [${full}];\nGO\n${code}` : code;
  }
  if (type === 'sqlite') {
    const k = kind === 'trigger' ? 'TRIGGER' : 'VIEW';
    return `DROP ${k} IF EXISTS "${name}";\n${code}`;
  }
  // oracle：CREATE OR REPLACE 直接可改；数据库链接/同义词等无 REPLACE 语义的先 DROP
  if (kind === 'dblink') {
    return `DROP DATABASE LINK ${g(name)};\n${code}`;
  }
  return code;
}

// 对象编辑器：新建/编辑 视图/函数/存储过程/触发器/事件/序列
export default function ObjEditTab({ connId, connName, db, schema, kind, name, isNew, session, dark, onStatus, onClose, refreshKey }) {
  const [code, setCode] = useState('');
  const [running, setRunning] = useState(false);
  const editorRef = useRef(null);

  useEffect(() => {
    if (isNew) {
      setCode(template(session ? session.type : 'mysql', kind, db, schema));
      return;
    }
    dbApi(connId, 'objectDdl', { db, schema, kind, name })
      .then((ddl) => setCode(prepareEdit(session ? session.type : 'mysql', kind, db, schema, name, ddl)))
      .catch((e) => {
        message.error(e.message);
        setCode('-- 读取对象源码失败：' + e.message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, schema, kind, name, isNew]);

  const run = async () => {
    if (!code.trim()) return;
    setRunning(true);
    try {
      const res = await dbApi(connId, 'query', { sqlText: code, db, schema });
      const errs = res.filter((r) => r.error);
      if (errs.length) {
        message.error(`有 ${errs.length} 条语句失败：${errs[0].error}`);
        onStatus(`对象保存失败：${errs[0].error}`);
        return;
      }
      message.success(`${KIND_LABEL[kind] || '对象'}已保存`);
      onStatus(`${isNew ? '新建' : '修改'}${KIND_LABEL[kind] || '对象'} ${name || ''} 完成`);
      window.dispatchEvent(new CustomEvent('dh-refresh-tree', { detail: { refreshKey } }));
      if (onClose) onClose();
    } catch (e) {
      message.error(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="tab-body">
      <div className="tab-toolbar">
        <Button size="small" type="primary" icon={<SaveOutlined />} loading={running} onClick={run}>
          {isNew ? '创建' : '保存'} <small>Ctrl+Enter</small>
        </Button>
        <span className="ctx">
          {connName} · {KIND_LABEL[kind] || kind}
          {db ? ` · ${db}` : schema ? ` · ${schema}` : ''}
          {name && !isNew ? ` · ${name}` : ''}
        </span>
      </div>
      <div className="query-editor-wrap" style={{ height: '100%' }}>
        <SqlEditor
          ref={editorRef}
          value={code}
          onChange={setCode}
          onRun={run}
          dialect={session ? session.type : 'standard'}
          dark={dark}
        />
      </div>
    </div>
  );
}
