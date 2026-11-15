#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const [repository, revision] = process.argv.slice(2);
if (!repository || !/^[a-f0-9]{40}$/i.test(revision)) {
  console.error('Usage: node scripts/build-project.mjs <git-repository-url> <full-40-character-commit-sha>');
  process.exit(2);
}
const root = await mkdtemp(join(tmpdir(), 'founder-build-'));
const source = join(root, 'source');
const second = join(root, 'second-instance');
const receipts = [];
const run = async (command, args, cwd) => {
  const started = new Date().toISOString();
  const output = [];
  const code = await new Promise((done, reject) => {
    const p = spawn(command, args, { cwd, env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', x => { output.push(x.toString()); process.stdout.write(x); });
    p.stderr.on('data', x => { output.push(x.toString()); process.stderr.write(x); });
    p.on('error', reject);
    p.on('close', done);
  });
  const record = { started, command, args, exitCode: code, outputSha256: createHash('sha256').update(output.join('')).digest('hex') };
  receipts.push(record);
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code})`);
  return output.join('');
};
try {
  await run('git', ['clone', '--no-checkout', '--', repository, source], root);
  await run('git', ['checkout', '--detach', revision], source);
  const head = (await run('git', ['rev-parse', 'HEAD'], source)).trim();
  if (head.toLowerCase() !== revision.toLowerCase()) throw new Error('Revision mismatch');
  await run('npm', ['ci', '--ignore-scripts'], source);
  await run('npm', ['test'], source);
  await run('npm', ['run', 'build'], source);
  const pack = await run('npm', ['pack', '--silent', '--ignore-scripts'], source);
  const filename = pack.trim().split('\n').at(-1).trim();
  const archive = join(source, filename);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await mkdir(second);
  await writeFile(join(second, 'package.json'), JSON.stringify({ name: 'rebuild-consumer', private: true, type: 'module', version: '1.0.0' }));
  await run('npm', ['install', '--ignore-scripts', archive], second);
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await run('node', [join(second, 'node_modules', pkg.name, 'dist/src/cli.js')], second);
  console.log(JSON.stringify({ status: 'PACKAGED', repository, revision, tarballSha256: digest, receipts }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'BLOCKED', reason: String(error), receipts }, null, 2));
  process.exitCode = 1;
} finally {
  // Keep scratch files until process exit only; receipts are emitted to stdout.
  await rm(root, { recursive: true, force: true });
}
