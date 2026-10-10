import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';

const inspection = JSON.parse(fs.readFileSync(0, 'utf8'));
const config = inspection.host;
assert.equal(config.Privileged, false);
assert.equal(config.ReadonlyRootfs, true);
assert.ok(config.CapDrop.includes('ALL'));
assert.ok(config.SecurityOpt.some(value => value.startsWith('no-new-privileges')));
assert.equal(config.NetworkMode, 'tju-mas-dev_agent');
assert.equal(Object.keys(config.PortBindings ?? {}).length, 0);
assert.deepEqual(Object.keys(inspection.networks), ['tju-mas-dev_agent']);
const projectRoot = process.env.HOST_PROJECT_ROOT;
assert.ok(projectRoot, '需要提供预期的宿主项目路径');
const bindMounts = new Map([
  ['/workspace', { source: projectRoot, rw: true }],
  ['/workspace/.git', { source: `${projectRoot}/.git`, rw: false }],
  ['/home/node/.pi/agent/models.json', { source: `${projectRoot}/.local-data/dev-container/models.json`, rw: false }],
]);
const volumePaths = [
  '/workspace/node_modules', '/workspace/apps/server/node_modules',
  '/workspace/apps/web/node_modules', '/workspace/packages/contracts/node_modules',
  '/workspace/packages/page-renderer/node_modules', '/workspace/packages/ui-components/node_modules',
  '/workspace/.local-data', '/home/node',
];
assert.equal(inspection.mounts.length, bindMounts.size + volumePaths.length);
for (const [destination, expected] of bindMounts) {
  const mount = inspection.mounts.find(value => value.Destination === destination);
  assert.ok(mount, `缺少挂载：${destination}`);
  assert.equal(mount.Type, 'bind');
  assert.equal(mount.Source, expected.source);
  assert.equal(mount.RW, expected.rw);
}
for (const destination of volumePaths) {
  const mount = inspection.mounts.find(value => value.Destination === destination);
  assert.equal(mount?.Type, 'volume', `需要独立 Linux 数据卷：${destination}`);
  assert.equal(mount.RW, true);
}
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 1000);
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
assert.equal(fs.existsSync('/Users/kylon'), false);
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\s+0+\n/);
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\s+1/);
assert.throws(() => fs.writeFileSync('/opt/isolation-check', 'test'), /EROFS|EACCES/);
assert.ok(fs.existsSync('/workspace/docs/development/contributing.md'));
assert.ok(fs.existsSync('/workspace/.git/HEAD'));
assert.throws(() => fs.accessSync('/workspace/.git', fs.constants.W_OK), /EROFS|EACCES/);
assert.equal(fs.existsSync('/workspace/.local-data/dev-container/pi.env'), false);
console.log('PASS: 项目目录直接读写、Git 元数据只读、Linux 依赖和运行数据独立；普通用户、只读系统、无宿主主目录／Docker 控制接口挂载。');

const routeLines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
assert.ok(routeLines.every(line => line.trim().split(/\s+/)[1] !== '00000000'));
await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '192.0.2.1', port: 443 });
  socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('未明确拒绝直接外联')); });
  socket.once('connect', () => { socket.destroy(); reject(new Error('容器可以绕过代理直接外联')); });
  socket.once('error', error => {
    if (['ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)) resolve();
    else reject(error);
  });
});
for (const target of ['127.0.0.1:443', '192.168.1.1:443', 'example.com:443']) {
  await new Promise((resolve, reject) => {
    const request = http.request({ host: 'egress', port: 3128, method: 'CONNECT', path: target });
    request.setTimeout(10000, () => request.destroy(new Error('代理检查超时')));
    request.once('connect', (response, socket) => {
      socket.destroy();
      try { assert.equal(response.statusCode, 403, `代理未拒绝 ${target}`); resolve(); }
      catch (error) { reject(error); }
    });
    request.once('error', reject);
    request.end();
  });
}
console.log('PASS: 无默认外联路由；代理拒绝回环、内网和未允许的公共域名。');

const sdk = await import('/workspace/apps/server/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
assert.equal(sdk.VERSION, '0.99.1');
assert.equal(typeof sdk.createAgentSession, 'function');
console.log('PASS: 容器内 Pi SDK 0.99.1 可导入；未创建会话、未调用模型。');

// 真正调用 Pi 的文件查找工具，检查系统 fd-find 是否可用且参数兼容。
// 找不到 fd 时禁止自动下载，避免检查依赖额外的联网权限。
process.env.PI_OFFLINE = '1';
const findResult = await sdk.createFindTool('/workspace').execute(
  'environment-find-check', { pattern: 'README.md', path: '/workspace', limit: 1000 },
  AbortSignal.timeout(5000),
);
assert.ok(findResult.content.some(part => part.type === 'text' && part.text.split('\n').includes('README.md')));
console.log('PASS: Pi find 工具能离线找到项目 README.md，无需启动时下载 fd。');
