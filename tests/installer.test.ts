import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildServerLaunch, detectClients, installCliClient, installJsonClient,
  mergeMcpJson, prepareExternalInvocation, removeCliClient, removeJsonClient,
  removeMcpJson, resolveCommandOnPath, runInstallerCommand,
  type DetectionContext, type DetectedClient,
} from '../src/installer.js';

function context(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return { platform: 'darwin', homeDir: '/portable/home', environment: {},
    resolveCommand: command => ['code', 'codex', 'claude', 'copilot', 'local-figma-mcp'].includes(command) ? `/portable/bin/${command}` : undefined,
    pathExists: () => false, ...overrides };
}
function client(configPath: string): DetectedClient {
  return { id: 'copilot', name: 'Copilot', detected: true, detectionReasons: [], strategy: 'json', configPath, topLevelKey: 'mcpServers' };
}
const launch = { command: 'local-figma-mcp', args: [] };

test('portable launch contains neither credentials nor source directory', () => {
  assert.deepEqual(buildServerLaunch('darwin'), launch);
  assert.deepEqual(buildServerLaunch('linux'), launch);
  assert.deepEqual(buildServerLaunch('win32', 'C:\\npm\\local-figma-mcp.cmd'), {
    command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'call', 'C:\\npm\\local-figma-mcp.cmd'],
  });
  assert.throws(() => buildServerLaunch('win32'), /resolving/);
  assert.throws(() => buildServerLaunch('win32', 'C:\\npm\\evil&tool.cmd'), /Unsafe/);
});

test('detect uses runtime directories and command presence for CLI clients', () => {
  const clients = detectClients(context({ platform: 'linux', environment: {
    XDG_CONFIG_HOME: '/portable/config', COPILOT_HOME: '/portable/copilot', CODEX_HOME: '/portable/codex', CLAUDE_CONFIG_DIR: '/portable/claude',
  } }));
  assert.equal(clients.find(c => c.id === 'copilot')?.configPath, '/portable/copilot/mcp-config.json');
  assert.equal(clients.find(c => c.id === 'vscode')?.configPath, '/portable/config/Code/User/mcp.json');
  assert.equal(clients.find(c => c.id === 'codex')?.configPath, '/portable/codex/config.toml');
  assert.equal(clients.find(c => c.id === 'claude-code')?.configPath, '/portable/claude/.claude.json');
  const residual = detectClients(context({ resolveCommand: () => undefined, pathExists: p => p.endsWith('.codex') }));
  assert.equal(residual.find(c => c.id === 'codex')?.detected, false);
  const win = detectClients(context({ platform: 'win32', environment: { APPDATA: '/portable/roaming' } }));
  assert.equal(win.find(c => c.id === 'vscode')?.configPath, '/portable/roaming/Code/User/mcp.json');
});

test('JSONC edits preserve unrelated servers, settings and comments', () => {
  const source = '{\n // preference\n "theme":"dark", "mcpServers":{"local-android":{"command":"local-android-mcp"}}\n}\n';
  const output = mergeMcpJson(source, 'mcpServers', launch);
  assert.match(output, /preference/);
  assert.match(output, /local-android/);
  assert.match(output, /local-figma/);
  assert.match(output, /"theme":\s*"dark"/);
  assert.doesNotMatch(removeMcpJson(output, 'mcpServers'), /local-figma/);
  assert.match(removeMcpJson(output, 'mcpServers'), /local-android/);
  assert.match(mergeMcpJson('', 'servers', launch, { type: 'stdio' }), /"type": "stdio"/);
});

test('malformed, duplicate and structurally incompatible JSON is rejected', () => {
  for (const source of ['{broken', '{"mcpServers":{},"mcpServers":{}}', '{"mcpServers":{"local-figma":{},"local-figma":{}}}', '[]', 'null', '{"mcpServers":1}', '{"mcpServers":[]}']) {
    assert.throws(() => mergeMcpJson(source, 'mcpServers', launch), /invalid|duplicate|object/i);
  }
});

test('installation plans do not create or alter files; application backs up original', async t => {
  const root = await mkdtemp(join(tmpdir(), 'figma-installer-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'mcp.json');
  await writeFile(path, '{"mcpServers":{"existing":{"command":"other"}}}\n', { mode: 0o600 });
  const original = await readFile(path, 'utf8');
  assert.equal((await installJsonClient(client(path), launch, { dryRun: true })).status, 'planned');
  assert.deepEqual(await readdir(root), ['mcp.json']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), JSON.parse(original));
  const result = await installJsonClient(client(path), launch, { timestamp: 'test' });
  assert.equal(result.status, 'installed');
  assert.equal(await readFile(result.backupPath!, 'utf8'), original);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await installJsonClient(client(path), launch)).status, 'unchanged');
  assert.equal((await removeJsonClient(client(path), launch, { dryRun: true })).status, 'planned');
  assert.equal((await removeJsonClient(client(path), launch)).status, 'removed');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), JSON.parse(original));
});

test('different same-named entry requires force and is preserved on rejection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'figma-conflict-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'mcp.json');
  const original = '{"mcpServers":{"local-figma":{"command":"other"}}}'; await writeFile(path, original);
  await assert.rejects(installJsonClient(client(path), launch), /--force/);
  await assert.rejects(removeJsonClient(client(path), launch), /--force/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal((await installJsonClient(client(path), launch, { force: true })).status, 'installed');
});

test('missing configurations are created privately and symlink configurations rejected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'figma-symlink-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'sub', 'mcp.json');
  assert.equal((await removeJsonClient(client(path), launch)).status, 'unchanged');
  assert.equal((await installJsonClient(client(path), launch)).status, 'installed');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await symlink(path, join(root, 'link.json'));
  await assert.rejects(installJsonClient(client(join(root, 'link.json')), launch), /symbolic/);
});

test('provider CLI dry run never invokes runner and applied changes require force', async () => {
  const codex = detectClients(context()).find(c => c.id === 'codex')!;
  let calls = 0;
  const runner = async (invocation: { command: string; args: string[] }) => {
    calls++; assert.deepEqual(invocation.args, ['mcp', 'add', 'local-figma', '--', 'local-figma-mcp']);
  };
  assert.equal((await installCliClient(codex, launch, { dryRun: true, runner })).status, 'planned');
  assert.equal(calls, 0);
  await assert.rejects(installCliClient(codex, launch, { runner }), /--force/);
  assert.equal((await installCliClient(codex, launch, { force: true, runner })).status, 'installed');
  assert.equal(calls, 1);
  assert.equal((await removeCliClient(codex, { dryRun: true })).status, 'planned');
  await assert.rejects(removeCliClient(codex), /--force/);
});

test('Windows provider invocation rejects shell metacharacters and quotes spaces', () => {
  const converted = prepareExternalInvocation({ command: 'C:\\Program Files\\npm\\claude.cmd', args: ['mcp', 'add', 'local-figma'] }, 'win32');
  assert.equal(converted.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.match(converted.args[3]!, /"C:\\Program Files/);
  assert.throws(() => prepareExternalInvocation({ command: 'C:\\npm\\claude.cmd', args: ['bad&arg'] }, 'win32'), /Unsafe/);
});

test('PATH resolver skips directories and nonexecutables', async t => {
  const root = await mkdtemp(join(tmpdir(), 'figma-path-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'first')); await mkdir(join(root, 'second'));
  await mkdir(join(root, 'first', 'tool')); await writeFile(join(root, 'second', 'tool'), '#!/bin/sh\n', { mode: 0o600 });
  assert.equal(resolveCommandOnPath('tool', `${root}/first:${root}/second`, 'darwin'), undefined);
  await chmod(join(root, 'second', 'tool'), 0o700);
  assert.equal(resolveCommandOnPath('tool', `${root}/first:${root}/second`, 'darwin'), join(root, 'second', 'tool'));
});

test('CLI setup defaults to read-only plan and applies only selected client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'figma-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const outputs: unknown[] = [];
  const injected = { context: context({ homeDir: root }), print: (v: unknown) => outputs.push(v) };
  assert.equal(await runInstallerCommand('setup', ['--client', 'copilot', '--json'], injected), 0);
  assert.equal((outputs[0] as { mode: string }).mode, 'plan');
  assert.deepEqual(await readdir(root), []);
  assert.equal(await runInstallerCommand('setup', ['--client=copilot', '--yes'], injected), 0);
  assert.match(await readFile(join(root, '.copilot', 'mcp-config.json'), 'utf8'), /local-figma-mcp/);
  assert.equal(await runInstallerCommand('uninstall', ['--client', 'copilot', '--yes'], injected), 0);
  assert.doesNotMatch(await readFile(join(root, '.copilot', 'mcp-config.json'), 'utf8'), /local-figma/);
});

test('CLI detection is read-only and invalid options are rejected', async () => {
  const output: unknown[] = [];
  const injected = { context: context(), print: (v: unknown) => output.push(v) };
  assert.equal(await runInstallerCommand('detect', ['--json'], injected), 0);
  assert.ok(Array.isArray(output[0]));
  await assert.rejects(runInstallerCommand('setup', ['--yes', '--dry-run'], injected), /either/);
  await assert.rejects(runInstallerCommand('setup', ['--client', 'unknown'], injected), /Unknown client/);
  await assert.rejects(runInstallerCommand('setup', ['--secret', 'not-accepted'], injected), /Unknown option/);
});
