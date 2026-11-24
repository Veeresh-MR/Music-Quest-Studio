// Runs the Tauri CLI with Rust's cargo folder on PATH, so it also works in terminals
// that were opened before Rust was installed.
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

const env = { ...process.env };
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${join(homedir(), '.cargo', 'bin')}${delimiter}${env[pathKey] || ''}`;

const result = spawnSync('tauri', process.argv.slice(2), { stdio: 'inherit', env, shell: true });
process.exit(result.status ?? 1);
