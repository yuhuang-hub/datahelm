'use strict';
// 电池 P0 重置：demo-test.db 复制自 demo.db 基线 + queries.json 清空 + 调试残留清理。
// 由电池编排串行调用；不要并行运行（并行 sqlite 写会互相破坏）。
const fs = require('fs');

fs.mkdirSync('D:/DataHelm/.tmp-ud7', { recursive: true });

// 1) 重置 sqlite 测试库（fixture 完整拥有该文件）
fs.copyFileSync('D:/DataHelm/demo.db', 'D:/DataHelm/.tmp-ud7/demo-test.db');

// 2) 查询历史清空（对象形态 {"queries":[]}）
fs.writeFileSync('D:/DataHelm/.tmp-ud7/queries.json', '{"queries":[]}');

// 3) 4) 上一轮调试残留（缺失则忽略）
try { fs.unlinkSync('D:/DataHelm/.tmp-ud7/ui-debug.log'); } catch (eIgnored) {}
try { fs.unlinkSync('D:/DataHelm/.tmp-ud7/DevToolsActivePort'); } catch (eIgnored) {}

console.log('RESET-OK');
