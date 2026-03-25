import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('Parent process.execArgv:', process.execArgv);
const childPath = path.resolve(__dirname, 'test-fork-child.ts');
console.log('Forking child at:', childPath);
const child = fork(childPath, [], { execArgv: process.execArgv, stdio: 'inherit' });
setTimeout(() => {
  console.error('Timeout');
  process.exit(1);
}, 5000);
