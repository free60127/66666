/** Package the exact tested build for both manual and GitHub Actions deployment. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sha = process.argv[2] || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Release must use a full Git commit SHA');
const archive = process.argv[3] || 'tmp/bts-release.tgz';
for (const file of ['dist/index.html', 'dist/teacher.html', 'server/index.mjs', 'package.json']) {
  if (!fs.existsSync(file)) throw new Error('Missing release file: ' + file);
}
fs.mkdirSync(path.dirname(archive), { recursive: true });
const assets = fs.readdirSync('dist/assets').filter(name => fs.statSync(path.join('dist/assets', name)).isFile());
fs.writeFileSync('dist/release.json', JSON.stringify({ commit: sha, builtAt: new Date().toISOString(), assets }) + '\n');
execFileSync('tar', ['-czf', archive, 'dist', 'server', 'src', 'public/corpus', 'package.json'], { stdio: 'inherit' });
console.log('Release ' + sha + ' packaged: ' + archive);
