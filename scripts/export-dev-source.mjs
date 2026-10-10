// 只导出 Git 可见的普通源码文件；不跟随链接，不包含凭据、运行数据或依赖。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('无法列出容器内源码文件。');
const files = result.stdout.split('\0').filter(path => {
  if (!path || path.split('/').some(part => ['.git', '.pi', '.local-data', 'node_modules', '.pnpm-store'].includes(part))) return false;
  const name = path.split('/').at(-1);
  if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') return false;
  if (/\.(log|jsonl|pem|key)$/.test(name)) return false;
  try { return fs.lstatSync(path).isFile(); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
});
const archive = spawnSync('tar', ['--null', '--verbatim-files-from', '-czf', '-', '-T', '-'], {
  input: files.join('\0') + '\0', stdio: ['pipe', 'inherit', 'inherit'],
});
process.exit(archive.status ?? 1);
