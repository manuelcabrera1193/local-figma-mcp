import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function dataRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.LOCAL_FIGMA_HOME) {
    if (!isAbsolute(env.LOCAL_FIGMA_HOME)) throw new Error('LOCAL_FIGMA_HOME must be absolute');
    return resolve(env.LOCAL_FIGMA_HOME);
  }
  const home = homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'local-figma-mcp');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home,'AppData','Local'), 'local-figma-mcp');
  return join(env.XDG_DATA_HOME || join(home,'.local','share'), 'local-figma-mcp');
}
