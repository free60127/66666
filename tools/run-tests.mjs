/** Run the full suite without inheriting production storage, SMTP or daily limits. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-suite-'));
const script = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts['test:core'];
let exitCode = 0;
try {
  for (const [i, command] of script.split('&&').entries()) {
    const args = command.trim().split(/\s+/);
    const runtime = args.shift();
    if (runtime === 'vitest') args.unshift('node_modules/vitest/vitest.mjs');
    else if (runtime !== 'node') throw new Error('Unsupported test runtime: ' + runtime);
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env,
        DATA_DIR: path.join(dir, String(i)), UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
        SMTP_TEST_MODE: '1', EMAIL_VERIFY: '0', FREE_DAILY_IP: '10000', FREE_DAILY_ACCOUNT: '10000',
        DAILY_SERVER_BUDGET: '10000', CLASS_KEY_DAILY: '10000',
      } });
      child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1));
    });
    if (exitCode) break;
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
process.exitCode = exitCode;
