import React, { useEffect, useState } from 'react';
import { AutoComplete, Button, Col, Collapse, Form, Input, Modal, Select, Space, Switch, message } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import { connApi, pickFile } from '../api';
import DbIcon from './DbIcons';

const PORTS = { mysql: 3306, mariadb: 3306, postgres: 5432, mssql: 1433, mongo: 27017, redis: 6379, oracle: 1521 };
const SQL_TYPES = ['mysql', 'mariadb', 'postgres', 'mssql', 'oracle'];

// 云数据库预设：底层协议与自建一致，只是预设端口/SSL/提示（与 Navicat 的云连接页签同思路）
const CLOUD_PRESETS = [
  { key: 'ali-mysql', label: '阿里云 RDS MySQL', type: 'mysql', port: 3306, ssl: true },
  { key: 'polar-mysql', label: 'PolarDB MySQL（阿里云）', type: 'mysql', port: 3306, ssl: true },
  { key: 'tx-mysql', label: '腾讯云 MySQL', type: 'mysql', port: 3306, ssl: true },
  { key: 'hw-mysql', label: '华为云 RDS MySQL', type: 'mysql', port: 3306, ssl: true },
  { key: 'aws-mysql', label: 'AWS RDS / Aurora MySQL', type: 'mysql', port: 3306, ssl: true },
  { key: 'azure-mysql', label: 'Azure Database for MySQL', type: 'mysql', port: 3306, ssl: true },
  { key: 'tidb', label: 'TiDB', type: 'mysql', port: 4000, ssl: false },
  { key: 'ob', label: 'OceanBase（MySQL 模式）', type: 'mysql', port: 2881, ssl: false },
  { key: 'ali-pg', label: '阿里云 RDS PostgreSQL / PolarDB-PG', type: 'postgres', port: 5432, ssl: true },
  { key: 'tx-pg', label: '腾讯云 PostgreSQL', type: 'postgres', port: 5432, ssl: true },
  { key: 'hw-pg', label: '华为云 RDS / GaussDB', type: 'postgres', port: 5432, ssl: true },
  { key: 'aws-pg', label: 'AWS RDS / Aurora PostgreSQL', type: 'postgres', port: 5432, ssl: true },
  { key: 'azure-pg', label: 'Azure Database for PostgreSQL', type: 'postgres', port: 5432, ssl: true },
  { key: 'supabase', label: 'Supabase', type: 'postgres', port: 5432, ssl: true },
  { key: 'neon', label: 'Neon', type: 'postgres', port: 5432, ssl: true },
  { key: 'crdb', label: 'CockroachDB', type: 'postgres', port: 26257, ssl: true },
  { key: 'mongo-atlas', label: 'MongoDB Atlas', type: 'mongo', port: 27017, ssl: true },
  { key: 'redis-cloud', label: 'Redis Cloud / 阿里云 Tair', type: 'redis', port: 6379, ssl: true },
];

export default function ConnectionModal({ open, record, onClose }) {
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);
  const type = Form.useWatch('type', form);

  useEffect(() => {
    if (open) {
      form.resetFields();
      if (record) form.setFieldsValue(record);
      else form.setFieldsValue({ type: 'mysql', config: { host: 'localhost', port: 3306, user: 'root' } });
    }
  }, [open, record, form]);

  const collect = async () => {
    const v = await form.validateFields();
    return {
      id: record ? record.id : undefined,
      name: v.name,
      type: v.type,
      cloud: v.cloud || '',
      config: { ...v.config, port: Number(v.config && v.config.port) || undefined },
    };
  };

  const test = async () => {
    try {
      setTesting(true);
      const cfg = await collect();
      const v = await connApi.test(cfg);
      message.success(`连接成功：${v}`);
    } catch (e) {
      message.error(`测试失败：${e.message}`);
    } finally {
      setTesting(false);
    }
  };

  const browseSqlite = async () => {
    const f = await pickFile({
      title: '选择 SQLite 数据库文件（不存在将新建）',
      filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }],
    });
    if (f) form.setFieldValue(['config', 'file'], f);
  };

  const browseKey = async () => {
    const f = await pickFile({ title: '选择 SSH 私钥文件', filters: [{ name: '所有文件', extensions: ['*'] }] });
    if (f) form.setFieldValue(['config', 'ssh', 'privateKey'], f);
  };

  return (
    <Modal
      open={open}
      title={record ? '连接属性' : '新建连接'}
      onCancel={onClose}
      width={560}
      footer={[
        <Button key="t" loading={testing} onClick={test}>
          测试连接
        </Button>,
        <Button key="c" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="ok"
          type="primary"
          onClick={async () => {
            try {
              const cfg = await collect();
              await connApi.save(cfg);
              message.success('已保存');
              onClose();
            } catch (e) {
              if (e.errorFields) return; // 表单校验错误已提示
              message.error(e.message);
            }
          }}
        >
          保存
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical" size="small">
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="name" label="连接名" rules={[{ required: true, message: '请输入连接名' }]} style={{ width: 240 }}>
            <Input placeholder="例如：本地 MySQL" />
          </Form.Item>
          <Form.Item name="type" label="数据库类型" initialValue="mysql" rules={[{ required: true }]}>
            <Select
              disabled={!!record}
              style={{ width: 260 }}
              showSearch
              optionFilterProp="label"
              optionRender={(o) => (
                <span className="dh-dbopt">
                  {String(o.value).startsWith('cloud:') ? '☁' : <DbIcon type={o.value} />}
                  {o.label}
                </span>
              )}
              onChange={(t) => {
                if (String(t).startsWith('cloud:')) {
                  const p = CLOUD_PRESETS.find((x) => x.key === t.slice(6));
                  if (p) {
                    form.setFieldsValue({
                      type: p.type,
                      cloud: p.label,
                      config: { ...(form.getFieldValue('config') || {}), port: p.port, ssl: p.ssl, sslVerify: false },
                    });
                    message.info(`已应用「${p.label}」预设：端口 ${p.port}${p.ssl ? '，SSL 开启（云库通常需在控制台加白名单本机 IP）' : ''}`);
                  }
                  return;
                }
                form.setFieldsValue({ cloud: '' });
                form.setFieldValue(['config', 'port'], PORTS[t] || form.getFieldValue(['config', 'port']));
              }}
              options={[
                {
                  label: '自建 / 标准',
                  options: [
                    { value: 'mysql', label: 'MySQL' },
                    { value: 'mariadb', label: 'MariaDB' },
                    { value: 'postgres', label: 'PostgreSQL' },
                    { value: 'sqlite', label: 'SQLite' },
                    { value: 'mssql', label: 'SQL Server' },
                    { value: 'oracle', label: 'Oracle' },
                    { value: 'mongo', label: 'MongoDB' },
                    { value: 'redis', label: 'Redis' },
                  ],
                },
                {
                  label: '云数据库（预设端口/SSL）',
                  options: CLOUD_PRESETS.map((p) => ({ value: 'cloud:' + p.key, label: '☁ ' + p.label })),
                },
              ]}
            />
          </Form.Item>
        </Space>
        <Form.Item name="cloud" hidden initialValue="">
          <Input />
        </Form.Item>
        {type && form.getFieldValue('cloud') ? (
          <div style={{ margin: '-12px 0 8px', color: '#0e8a6a', fontSize: 12 }}>云预设：{form.getFieldValue('cloud')}（按对应协议直连，请在云控制台放行本机 IP）</div>
        ) : null}

        {type === 'sqlite' ? (
          <Form.Item name={['config', 'file']} label="数据库文件（不存在将自动新建）" rules={[{ required: true, message: '请选择或输入文件路径' }]}>
            <Input
              addonAfter={
                <Button type="text" size="small" icon={<FolderOpenOutlined />} onClick={browseSqlite} style={{ margin: -4, padding: '0 4px' }} />
              }
              placeholder="D:\data\my.db"
            />
          </Form.Item>
        ) : type === 'mongo' || type === 'redis' ? (
          <>
            <Space style={{ display: 'flex' }} align="start" wrap>
              <Form.Item name={['config', 'host']} label="主机" rules={[{ required: true, message: '必填' }]}>
                <Input style={{ width: 220 }} placeholder="localhost" />
              </Form.Item>
              <Form.Item name={['config', 'port']} label="端口" rules={[{ required: true, message: '必填' }]}>
                <Input style={{ width: 90 }} placeholder={String(PORTS[type] || '')} />
              </Form.Item>
              {type === 'mongo' && (
                <Form.Item name={['config', 'user']} label="用户名（可选）">
                  <Input style={{ width: 130 }} />
                </Form.Item>
              )}
            </Space>
            <Space style={{ display: 'flex' }} align="start" wrap>
              <Form.Item name={['config', 'password']} label="密码">
                <Input.Password style={{ width: 180 }} />
              </Form.Item>
              {type === 'mongo' && (
                <>
                  <Form.Item name={['config', 'authDb']} label="认证库" initialValue="admin">
                    <Input style={{ width: 110 }} placeholder="admin" />
                  </Form.Item>
                  <Form.Item name={['config', 'database']} label="初始库（可选）">
                    <Input style={{ width: 130 }} />
                  </Form.Item>
                </>
              )}
              {type === 'redis' && (
                <Form.Item name={['config', 'db']} label="初始 DB 编号">
                  <Input style={{ width: 100 }} placeholder="0" />
                </Form.Item>
              )}
              <Form.Item name={['config', 'ssl']} label="TLS/SSL" valuePropName="checked">
                <Switch size="small" />
              </Form.Item>
            </Space>
          </>
        ) : (
          <>
            <Space style={{ display: 'flex' }} align="start" wrap>
              <Form.Item name={['config', 'host']} label="主机" rules={[{ required: true, message: '必填' }]}>
                <Input style={{ width: 220 }} placeholder="localhost" />
              </Form.Item>
              <Form.Item name={['config', 'port']} label="端口" rules={[{ required: true, message: '必填' }]}>
                <Input style={{ width: 90 }} placeholder={String(PORTS[type] || '')} />
              </Form.Item>
              <Form.Item name={['config', 'user']} label="用户名" rules={[{ required: true, message: '必填' }]}>
                <Input style={{ width: 140 }} placeholder={type === 'postgres' ? 'postgres' : type === 'mssql' ? 'sa' : 'root'} />
              </Form.Item>
            </Space>
            <Space style={{ display: 'flex' }} align="start" wrap>
              <Form.Item name={['config', 'password']} label="密码">
                <Input.Password style={{ width: 220 }} />
              </Form.Item>
              {type === 'oracle' ? (
                <Form.Item name={['config', 'serviceName']} label="服务名 / PDB" rules={[{ required: true, message: '必填' }]}>
                  <Input style={{ width: 180 }} placeholder="ORCL / XEPDB1 / FREEPDB1" />
                </Form.Item>
              ) : (
                <Form.Item name={['config', 'database']} label={type === 'postgres' ? '数据库' : '初始数据库（可选）'}>
                  <Input style={{ width: 180 }} placeholder={type === 'postgres' ? 'postgres' : type === 'mssql' ? 'master' : ''} />
                </Form.Item>
              )}
              <Form.Item name={['config', 'ssl']} label="使用 SSL" valuePropName="checked">
                <Switch size="small" />
              </Form.Item>
              <Form.Item name={['config', 'sslVerify']} label="严格验证证书" valuePropName="checked">
                <Switch size="small" />
              </Form.Item>
            </Space>
            <Collapse
              size="small"
              items={[
                {
                  key: 'ssh',
                  label: 'SSH 隧道（可选）',
                  children: (
                    <>
                      <Form.Item name={['config', 'ssh', 'enabled']} label="启用 SSH 隧道" valuePropName="checked">
                        <Switch size="small" />
                      </Form.Item>
                      <Space style={{ display: 'flex' }} align="start" wrap>
                        <Form.Item name={['config', 'ssh', 'host']} label="SSH 主机">
                          <Input style={{ width: 190 }} />
                        </Form.Item>
                        <Form.Item name={['config', 'ssh', 'port']} label="端口" initialValue={22}>
                          <Input style={{ width: 80 }} />
                        </Form.Item>
                        <Form.Item name={['config', 'ssh', 'user']} label="用户名">
                          <Input style={{ width: 120 }} />
                        </Form.Item>
                      </Space>
                      <Space style={{ display: 'flex' }} align="start" wrap>
                        <Form.Item name={['config', 'ssh', 'password']} label="密码">
                          <Input.Password style={{ width: 190 }} />
                        </Form.Item>
                        <Form.Item name={['config', 'ssh', 'privateKey']} label="私钥文件">
                          <AutoComplete
                            style={{ width: 230 }}
                            options={[]}
                            suffix={
                              <Button type="text" size="small" icon={<FolderOpenOutlined />} onClick={browseKey} style={{ margin: -4 }} />
                            }
                          />
                        </Form.Item>
                        <Form.Item name={['config', 'ssh', 'passphrase']} label="私钥口令">
                          <Input.Password style={{ width: 140 }} />
                        </Form.Item>
                      </Space>
                    </>
                  ),
                },
              ]}
            />
          </>
        )}
      </Form>
    </Modal>
  );
}
