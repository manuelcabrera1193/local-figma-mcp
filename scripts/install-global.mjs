// Adapted from local-android-mcp, MIT License. Copyright (c) 2026 local-android-mcp contributors.
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this through 'npm run install:global'");
const root = fileURLToPath(new URL('../', import.meta.url));
const packed = spawnSync(process.execPath, [npmCli, 'pack', '--json'], {
  cwd: root, encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 2_000_000,
});
if (packed.error) throw packed.error;
if (packed.status !== 0) {
  process.stderr.write(packed.stderr || 'npm pack failed\n');
  process.exit(packed.status ?? 1);
}
const result = JSON.parse(packed.stdout);
const filename = result[0]?.filename;
if (typeof filename !== 'string' || filename !== basename(filename) || !filename.endsWith('.tgz')) {
  throw new Error('npm pack did not report a safe package filename');
}
const installed = spawnSync(process.execPath, [npmCli, 'install', '--global', resolve(root, filename)], {
  cwd: root, shell: false, stdio: 'inherit', timeout: 120_000,
});
if (installed.error) throw installed.error;
if (installed.status !== 0) process.exit(installed.status ?? 1);
process.stderr.write("Installed a self-contained 'local-figma-mcp' command. Moving the source folder will not break it. Run 'local-figma-mcp setup' to inspect client configuration changes.\n");
