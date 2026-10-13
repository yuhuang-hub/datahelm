'use strict';
const fs = require('fs');
const net = require('net');
const { Client } = require('ssh2');

// 建立 SSH 隧道：本地随机端口 -> (经跳板机) -> 数据库 host:port
function open(ssh, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const server = net.createServer();

    const opts = {
      host: ssh.host,
      port: Number(ssh.port) || 22,
      username: ssh.user,
      readyTimeout: 15000,
    };
    if (ssh.privateKey) {
      try {
        opts.privateKey = fs.readFileSync(ssh.privateKey);
      } catch (e) {
        reject(new Error('读取 SSH 私钥失败: ' + e.message));
        return;
      }
      if (ssh.passphrase) opts.passphrase = ssh.passphrase;
    } else if (ssh.password) {
      opts.password = ssh.password;
    } else {
      reject(new Error('SSH 隧道需要密码或私钥'));
      return;
    }

    server.on('error', reject);
    client.on('error', reject);
    client.on('ready', () => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.on('connection', (sock) => {
          client.forwardOut(sock.remoteAddress, sock.remotePort, targetHost, targetPort, (err, stream) => {
            if (err) {
              sock.destroy();
              return;
            }
            sock.pipe(stream).pipe(sock);
            stream.on('error', () => sock.destroy());
            sock.on('error', () => stream.destroy());
          });
        });
        resolve({
          port,
          close: () => {
            try { server.close(); } catch {}
            try { client.end(); } catch {}
          },
        });
      });
    });
    client.connect(opts);
  });
}

module.exports = { open };
