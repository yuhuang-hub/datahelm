# DataHelm ⛵

Navicat Premium 风格的**桌面数据库管理客户端**（独立实现，不包含任何 Navicat 官方代码/图标/资源）。
Electron + React + Ant Design，主进程直连数据库，支持 **MySQL / MariaDB / PostgreSQL / SQLite / SQL Server / Oracle / MongoDB / Redis**，并提供主流云数据库连接预设。

## 功能

| 模块 | 说明 |
| --- | --- |
| 连接管理 | 新建/编辑/删除连接、测试连接、SSH 隧道（密码/私钥）、SSL（可选严格证书校验） |
| 云数据库 | 类型下拉内置 **18 个云预设**（阿里云 RDS/PolarDB、腾讯云、华为云/GaussDB、AWS RDS/Aurora、Azure、TiDB、OceanBase、Supabase、Neon、CockroachDB、MongoDB Atlas、Redis Cloud/Tair），自动填端口/开 SSL，按对应协议直连 |
| 对象树 | 连接 → 库/模式 → **表/视图/函数/存储过程/触发器/事件/序列**（按库类型）；**双击展开/收起**；右键菜单：打开表、设计表、新建查询、复制 DDL、重命名、清空、删除、新建数据库/表/集合、导入 CSV、数据传输 |
| 对象列表页 | 工具栏「表 / 视图」打开库级清单：名称/注释/行数、搜索、行内展开结构面板（字段/索引/外键/唯一键/检查/触发器）；**SQL Server 默认列出全部架构**（dbo + 自定义 schema），带架构列与架构筛选下拉，行操作按所属架构透传 |
| 数据表格 | 分页浏览（50~5000 行/页）、WHERE 筛选、列排序、单击编辑单元格、右键设 NULL/复制单元格/复制行 CSV、新增/删除行、保存更改（参数化 SQL）、单元格脏标记 |
| SQL 查询 | CodeMirror 6 编辑器（高亮/表名列名补全/右键菜单）、Ctrl+Enter 运行、运行选中、多语句多结果集、消息面板（耗时分级标色）、**执行计划（EXPLAIN/SHOWPLAN 算符树 + 表格双视图）**、SQL 美化/压缩、注释切换、**保存查询 + 查询列表（跨会话）** |
| 查询历史 | 最近 50 条/连接：**跨连接聚合视图**、执行耗时与慢查询标记（≥1s 橙 / ≥5s 红）、失败标记、**关键词搜索**、**收藏星标 + 只看收藏** |
| 结果对比 | 任意两次运行的结果集并排 diff：固定为基准（**多快照管理**：命名/切换/删除）、位置对齐 或 **按键对齐**（同名列作主键 diff）、差异格高亮 / 缺格灰显、行数列数差异统计 |
| 表设计器 | 列编辑（名/类型/长度/小数/主键/非空/自增/默认值/注释）、**拖拽调列序**（MySQL `MODIFY…AFTER`；SQLite/PostgreSQL/SQL Server 自动重建表保数据并复原索引/约束）、索引/外键/唯一键/检查/触发器/选项/注释页签、SQL 预览、**重建表时的他表外键引用提示** |
| 视图设计器 | 卡片式可视化建视图：多表字段勾选、外键自动推断 JOIN、连接类型切换（INNER/LEFT…）、别名、SQL 实时预览 |
| 对象编辑器 | **新建/编辑 视图、函数、存储过程、触发器、事件、序列**：按方言生成模板（含 MySQL `DELIMITER`、PG `$$`、MSSQL `GO`、Oracle `/` 脚本约定），编辑已有对象自动加 DROP/CREATE OR REPLACE 前缀，保存即执行并刷新对象树 |
| 结构同步 | 源/目标连接选库 → 比较同名表结构差异（列/索引/唯一键/外键/检查）→ 生成 DDL 预览 → 应用；跨方言自动类型映射 |
| 数据同步 | 源/目标按主键逐行比较同名表数据 → INSERT/UPDATE/DELETE 预览 → 应用 |
| ER 图 | 库/schema 表关系图：表盒子 + 外键自动连线、拖拽布局（持久化）+ 缩放、导出 PNG |
| 导入导出 | **导入向导**（四步：CSV/JSON 文件 → 新建表/现有表 → 字段映射 → 执行）；**导出** CSV / JSON / SQL INSERT / Markdown / HTML；表右键 **SQL 转储**（DDL + INSERT） |
| 数据传输 | 表右键 → 复制到其他连接（跨库类型，目标重建表 + 500 行/批参数化写入；支持 Oracle 目标） |
| 用户管理 | MySQL/MariaDB（`mysql.user`）与 PostgreSQL（`pg_roles`）：列出用户、新建（含密码/Host/LOGIN）、删除、查看权限（SHOW GRANTS / information_schema）、快捷 GRANT（常用权限勾选 + 库范围） |
| 备份自动化 | **SQL 备份计划**（CREATE + INSERT 全量导出）：每天定时或固定间隔、启停、立即备份、打开备份文件；主进程 30s 轮询调度，状态/文件路径持久化；恢复 = 备份文件在恢复页执行 |
| 标签页 | 每个对象独立标签，关闭按钮 + 鼠标中键关闭，**关闭的标签可恢复**（含未保存草稿），脏标记绿点提示 |
| MongoDB | 库 → 集合浏览（JSON 只读分页/筛选/排序）、JSON 查询 `{"collection":..,"filter":..,"limit":..}`、按 _id 删行 |
| Redis | db 键浏览器（SCAN 分页、类型标签、值查看）、删除键、FLUSHDB（出于安全不提供自由命令行） |
| 其它 | 深浅色主题、状态栏（服务器版本/耗时/行数）、DevTools 快捷键已禁用（产品化）、连接配置持久化到 userData/connections.json |

## 快速开始

```bash
npm install        # 国内网络可加 --registry=https://registry.npmmirror.com
npm run build      # 构建渲染层（vite → dist/）
npm start          # 启动桌面应用
```

开发模式（热更新）：

```bash
npm run dev
```

自测（无外部数据库依赖，SQLite 端到端 + 驱动加载检查 + DELIMITER/Oracle 方言断言）：

```bash
npm run selftest
```

打包 Windows 安装包与便携版（NSIS + portable，输出在 `release/`）：

```bash
npm run dist:win   # vite build + electron-builder --win nsis portable
```

> 国内网络首次打包下载 NSIS 工具链若超时，带镜像环境变量重跑：
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist:win`

## 架构

```
electron/                 主进程（Node）
  main.js                 窗口 + IPC（contextIsolation，preload 桥接）+ 备份调度启动
  preload.js
  services/
    connections.js        连接配置存储（userData/connections.json）
    queries.js            保存的查询（userData/queries.json）
    backup.js             备份计划存储/调度/执行（userData/backups.json + backups/）
    tunnel.js             SSH 隧道（ssh2，本地随机端口转发）
    sqlutil.js            SQL 工具：语句切分（GO/DELIMITER/$$）/标识符引用/参数化变更/建表改表生成/五方言占位符
    csv.js                CSV 解析（引号/转义/自动分隔符嗅探）
    db/
      index.js            会话管理 + 统一调用入口 + 数据传输编排 + 临时会话
      mysql.js(含 MariaDB)  postgres.js  sqlite.js  mssql.js  mongo.js  redis.js  oracle.js
src/                      渲染层（React + antd + CodeMirror）
  App.jsx                 布局/标签页(关闭按钮+中键+恢复)/工具栏/主题/事件路由
  components/Sidebar.jsx  连接树（双击展开收起/懒加载/右键菜单/树刷新事件）
  components/SqlEditor.jsx        CodeMirror 封装（补全/快捷键/右键菜单）
  components/ImportWizard.jsx     导入向导（CSV/JSON 四步）
  components/ExportModal.jsx      导出（CSV/JSON/SQL/MD/HTML）
  components/tabs/        DataTab(数据网格) QueryTab(查询+历史+对比) DesignTab(表设计器)
                         ViewDesignTab(视图设计器) ObjEditTab(对象编辑器) ObjListTab(对象列表)
                         SyncTab(结构同步) DataSyncTab(数据同步) ErTab(ER 图)
                         UsersTab(用户管理) BackupsTab(备份计划) RestoreTab(恢复) DdlTab RedisTab
scripts/                  测试基建（见下）
dist/                     vite 构建产物（不入库）
```

- 所有数据库访问在主进程，渲染层经 `window.api`（contextBridge）调用。
- 驱动统一接口：`treeRoot/treeChildren/columns/page/query/changes/ddl/objectDdl/tables/objList/schemas/inFkeys/alterScript/applyAlter/importCsv/dumpTable/users/grantTo/drop*` 等，全部纯 JS（mysql2/pg/sql.js/tedious/mongodb/ioredis/**oracledb thin**），无原生编译依赖。
- **数据值一律参数化绑定**（mysql/sqlite `?`、pg `$n`、mssql `@pN` NVarChar、oracle `:n`），标识符按方言转义。
- Oracle 使用 node-oracledb 6+ **thin 模式**（纯 JS，无需安装 Oracle Instant Client）：服务名连接、ROWNUM 分页、`dbms_metadata.get_ddl` 源码导出、PL/SQL 以 `/` 分隔执行。
- SQLite 经 [sql.js](https://sql.js)（WASM，打包时 asarUnpack），写入时导出回写文件。

## 测试

- `scripts/battery-v19.sh`：**55 套件 / 749 断言**的 CDP 端到端电池——起真实 Electron 实例驱动 UI（树/网格/编辑器/设计器/同步/传输/导入导出/备份），另含驱动层方言断言与可重入夹具（`scripts/fx/`）。
- `npm run selftest`：SQLite 全链路快速自测。
- 测试夹具中的数据库连接（`localhost` SQL Server `sa` 等）**仅指向本机开发自测库**，与任何生产环境无关。

## 与 Navicat 的差异（未实现）

达梦等国产库（无纯 JS 驱动）、Redis 自由命令行（安全收口）、Navicat Cloud 配置同步、查询窗口自动重连。核心日常工作流（浏览/编辑数据、写 SQL、改表结构、对象开发、结构/数据同步、导入导出、用户授权、备份计划、跨库搬表）已覆盖。

## 已知限制

- 密码明文保存在本地 connections.json（与 Navicat 配置文件做法类似），请勿在共享机器上保存生产密码。
- 设计器对 MySQL `unsigned/zerofill` 等类型修饰符做归一化，往返保存可能丢失修饰符；Oracle/云库建议直接在查询窗口写 ALTER。
- Oracle 表设计器（可视化改列）未实现，用对象编辑器/查询窗口执行 ALTER；Oracle"数据库"即方案，不支持在应用内建库。
- PG/MSSQL 备份的 CREATE TABLE 为近似 DDL（不含索引/约束），数据 INSERT 精确；MySQL/SQLite/Oracle 的 DDL 为服务器原始定义。
- 备份为逻辑导出（SQL 文件），不含二进制大对象优化。
- SQL Server 列默认值变更不生成脚本（需手工执行）；PG 自增列切换不生成脚本。
- SQLite 重建表会复原原索引，但不迁移触发器。
- MongoDB 数据网格为只读（删除行除外），嵌套文档以 JSON 字符串显示；MongoDB/Redis 不支持备份计划与用户管理。
- 数据传输/结构同步按源表结构在目标重建表（类型做通用映射），不含触发器/视图。
- 云数据库预设只预设端口/SSL/提示，需自行在云控制台把本机 IP 加入白名单。

## License

[MIT](./LICENSE)
