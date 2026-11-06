// Adapted from local-android-mcp, MIT License. Copyright (c) 2026 local-android-mcp contributors.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import { applyEdits, modify, parse, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";

export type ClientId =
  | "vscode"
  | "copilot"
  | "cursor"
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "gemini"
  | "devin"
  | "windsurf-legacy";

export interface ServerLaunch {
  command: string;
  args: string[];
}

export interface DetectionContext {
  platform: NodeJS.Platform;
  homeDir: string;
  environment: Record<string, string | undefined>;
  resolveCommand: (command: string) => string | undefined;
  pathExists: (path: string) => boolean;
}

export interface DetectedClient {
  id: ClientId;
  name: string;
  detected: boolean;
  detectionReasons: string[];
  strategy: "json" | "cli";
  configPath?: string;
  topLevelKey?: "servers" | "mcpServers";
  cliCommand?: string;
  cliArgs?: string[];
  legacy?: boolean;
}

export interface JsonMergeOptions {
  type?: "stdio";
}

export interface InstallJsonOptions {
  force?: boolean;
  dryRun?: boolean;
  timestamp?: string;
}

export interface InstallResult {
  clientId: ClientId;
  status: "planned" | "installed" | "unchanged" | "removed";
  message: string;
  backupPath?: string;
}

export interface ExternalInvocation {
  command: string;
  args: string[];
}

export type ExternalRunner = (invocation: ExternalInvocation) => Promise<void>;

function appData(context: DetectionContext): string {
  if (context.platform === "win32") {
    return context.environment.APPDATA?.trim() || join(context.homeDir, "AppData", "Roaming");
  }
  if (context.platform === "darwin") return join(context.homeDir, "Library", "Application Support");
  return context.environment.XDG_CONFIG_HOME?.trim() || join(context.homeDir, ".config");
}

function detect(
  context: DetectionContext,
  commands: string[],
  markers: string[],
): { detected: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const command of commands) {
    const resolved = context.resolveCommand(command);
    if (resolved) reasons.push(`command:${command}=${resolved}`);
  }
  for (const marker of markers) {
    if (context.pathExists(marker)) reasons.push(`path:${marker}`);
  }
  return { detected: reasons.length > 0, reasons };
}

export function buildServerLaunch(
  platform: NodeJS.Platform = process.platform,
  resolvedCommand?: string,
  comspec = process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
): ServerLaunch {
  if (platform !== "win32") return { command: "local-figma-mcp", args: [] };
  if (!resolvedCommand) throw new Error("Cannot configure Windows before resolving local-figma-mcp on PATH");
  if (!/^[A-Za-z]:\\[^\r\n"%!*?<>|&^]+\.(?:cmd|bat)$/iu.test(resolvedCommand)) {
    throw new Error(`Unsafe or unsupported Windows command shim path: ${resolvedCommand}`);
  }
  if (!/^[A-Za-z]:\\[^\r\n"%!*?<>|&^]+\\cmd\.exe$/iu.test(comspec)) {
    throw new Error(`Unsafe Windows command processor path: ${comspec}`);
  }
  return { command: comspec, args: ["/d", "/s", "/c", "call", resolvedCommand] };
}

export function buildCliInstallInvocation(
  client: DetectedClient,
  launch: ServerLaunch,
): ExternalInvocation {
  if (client.strategy !== "cli" || !client.cliCommand || !client.cliArgs) {
    throw new Error(`${client.name} is not configured through a provider CLI`);
  }
  return {
    command: client.cliCommand,
    args: [...client.cliArgs, launch.command, ...launch.args],
  };
}

export function prepareExternalInvocation(
  invocation: ExternalInvocation,
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
): ExternalInvocation {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(invocation.command)) return invocation;
  if (!/^[A-Za-z]:\\[^\r\n"%!*?<>|&^]+\.(?:cmd|bat)$/iu.test(invocation.command)) {
    throw new Error(`Unsafe Windows provider command path: ${invocation.command}`);
  }
  const quote = (argument: string): string => {
    if (/[%!*?<>|&^"\r\n]/u.test(argument)) throw new Error("Unsafe argument for Windows provider command");
    return /\s/u.test(argument) ? `"${argument}"` : argument;
  };
  const commandLine = ["call", quote(invocation.command), ...invocation.args.map(quote)].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", commandLine],
  };
}

export function buildCliRemoveInvocation(client: DetectedClient): ExternalInvocation {
  if (client.strategy !== "cli" || !client.cliCommand) {
    throw new Error(`${client.name} is not configured through a provider CLI`);
  }
  const argsByClient: Partial<Record<ClientId, string[]>> = {
    "claude-code": ["mcp", "remove", "--scope", "user", "local-figma"],
    codex: ["mcp", "remove", "local-figma"],
    gemini: ["mcp", "remove", "--scope", "user", "local-figma"],
    devin: ["mcp", "remove", "-s", "user", "local-figma"],
  };
  const args = argsByClient[client.id];
  if (!args) throw new Error(`No safe uninstall command is known for ${client.name}`);
  return { command: client.cliCommand, args };
}

export function detectClients(context: DetectionContext): DetectedClient[] {
  const configHome = appData(context);
  const vscodeConfig = join(configHome, "Code", "User", "mcp.json");
  const copilotHome = context.environment.COPILOT_HOME?.trim() || join(context.homeDir, ".copilot");
  const copilotConfig = join(copilotHome, "mcp-config.json");
  const cursorConfig = join(context.homeDir, ".cursor", "mcp.json");
  const geminiConfig = join(context.homeDir, ".gemini", "settings.json");
  const codexHome = context.environment.CODEX_HOME?.trim() || join(context.homeDir, ".codex");
  const codexConfig = join(codexHome, "config.toml");
  const claudeConfigDir = context.environment.CLAUDE_CONFIG_DIR?.trim();
  const claudeCodeConfig = claudeConfigDir
    ? join(claudeConfigDir, ".claude.json")
    : join(context.homeDir, ".claude.json");
  const claudeDesktopConfig =
    context.platform === "win32"
      ? join(configHome, "Claude", "claude_desktop_config.json")
      : context.platform === "darwin"
        ? join(configHome, "Claude", "claude_desktop_config.json")
        : join(configHome, "Claude", "claude_desktop_config.json");
  const devinConfig = join(configHome, "devin", "mcp_config.json");
  const windsurfConfig = join(context.homeDir, ".codeium", "windsurf", "mcp_config.json");

  const app = (name: string): string[] => {
    if (context.platform === "darwin") return [`/Applications/${name}.app`, join(context.homeDir, "Applications", `${name}.app`)];
    return [];
  };

  const vscode = detect(context, ["code"], [vscodeConfig, ...app("Visual Studio Code")]);
  const copilot = detect(context, ["copilot"], [copilotConfig, copilotHome]);
  const cursor = detect(context, ["cursor", "cursor-agent"], [cursorConfig, join(context.homeDir, ".cursor"), ...app("Cursor")]);
  const claudeCode = detect(context, ["claude"], [
    claudeCodeConfig,
    claudeConfigDir || join(context.homeDir, ".claude"),
  ]);
  const claudeDesktop = detect(context, [], [claudeDesktopConfig, ...app("Claude")]);
  const codex = detect(context, ["codex"], [codexConfig, codexHome, ...app("Codex")]);
  const gemini = detect(context, ["gemini"], [geminiConfig, join(context.homeDir, ".gemini")]);
  const devin = detect(context, ["devin"], [devinConfig, ...app("Devin")]);
  const windsurf = detect(context, ["windsurf"], [windsurfConfig, ...app("Windsurf")]);

  const clients: DetectedClient[] = [
    {
      id: "vscode",
      name: "VS Code / GitHub Copilot",
      detected: vscode.detected,
      detectionReasons: vscode.reasons,
      strategy: "json",
      configPath: vscodeConfig,
      topLevelKey: "servers",
    },
    {
      id: "copilot",
      name: "GitHub Copilot CLI",
      detected: copilot.detected,
      detectionReasons: copilot.reasons,
      strategy: "json",
      configPath: copilotConfig,
      topLevelKey: "mcpServers",
    },
    {
      id: "cursor",
      name: "Cursor IDE / CLI",
      detected: cursor.detected,
      detectionReasons: cursor.reasons,
      strategy: "json",
      configPath: cursorConfig,
      topLevelKey: "mcpServers",
    },
    {
      id: "claude-code",
      name: "Claude Code",
      detected: Boolean(context.resolveCommand("claude")),
      detectionReasons: claudeCode.reasons,
      strategy: "cli",
      configPath: claudeCodeConfig,
      cliCommand: context.resolveCommand("claude") ?? "claude",
      cliArgs: ["mcp", "add", "--scope", "user", "local-figma", "--"],
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop (local stdio compatibility)",
      detected: claudeDesktop.detected,
      detectionReasons: claudeDesktop.reasons,
      strategy: "json",
      configPath: claudeDesktopConfig,
      topLevelKey: "mcpServers",
    },
    {
      id: "codex",
      name: "Codex CLI / Desktop / IDE",
      detected: Boolean(context.resolveCommand("codex")),
      detectionReasons: codex.reasons,
      strategy: "cli",
      configPath: codexConfig,
      cliCommand: context.resolveCommand("codex") ?? "codex",
      cliArgs: ["mcp", "add", "local-figma", "--"],
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      detected: gemini.detected,
      detectionReasons: gemini.reasons,
      strategy: "json",
      configPath: geminiConfig,
      topLevelKey: "mcpServers",
    },
    {
      id: "devin",
      name: "Devin Desktop / CLI",
      detected: Boolean(context.resolveCommand("devin")),
      detectionReasons: devin.reasons,
      strategy: "cli",
      configPath: devinConfig,
      cliCommand: context.resolveCommand("devin") ?? "devin",
      cliArgs: ["mcp", "add", "-s", "user", "local-figma", "--"],
    },
    {
      id: "windsurf-legacy",
      name: "Windsurf legacy",
      detected: windsurf.detected,
      detectionReasons: windsurf.reasons,
      strategy: "json",
      configPath: windsurfConfig,
      topLevelKey: "mcpServers",
      legacy: true,
    },
  ];
  return clients;
}

function assertValidJson(source: string): void {
  const errors: ParseError[] = [];
  const tree = parseTree(source || "{}", errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`Refusing to overwrite invalid JSON (${printParseErrorCode(first.error)} at offset ${first.offset})`);
  }
  const inspect = (node: Node, path: string): void => {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (typeof key !== "string") continue;
        if (keys.has(key)) throw new Error(`Refusing JSON with duplicate key '${path}${key}'`);
        keys.add(key);
        const value = property.children?.[1];
        if (value) inspect(value, `${path}${key}.`);
      }
    } else {
      for (const child of node.children ?? []) inspect(child, path);
    }
  };
  if (!tree || tree.type !== "object") throw new Error("MCP configuration must be a JSON object");
  inspect(tree, "");
}

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

export function mergeMcpJson(
  source: string,
  topLevelKey: "servers" | "mcpServers",
  launch: ServerLaunch,
  options: JsonMergeOptions = {},
): string {
  const base = source.trim() ? source : "{}\n";
  assertValidJson(base);
  configuredServer(base, topLevelKey);
  const server = options.type ? { type: options.type, ...launch } : launch;
  return applyEdits(
    base,
    modify(base, [topLevelKey, "local-figma"], server, { formattingOptions }),
  );
}

export function removeMcpJson(source: string, topLevelKey: "servers" | "mcpServers"): string {
  const base = source.trim() ? source : "{}\n";
  assertValidJson(base);
  return applyEdits(
    base,
    modify(base, [topLevelKey, "local-figma"], undefined, { formattingOptions }),
  );
}

function configuredServer(
  source: string,
  topLevelKey: "servers" | "mcpServers",
): unknown {
  assertValidJson(source || "{}");
  const errors: ParseError[] = [];
  const document = parse(source || "{}", errors, { allowTrailingComma: true, disallowComments: false }) as
    | Record<string, unknown>
    | undefined;
  if (errors.length > 0) assertValidJson(source);
  const servers = document?.[topLevelKey];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`${topLevelKey} must be a JSON object`);
  }
  if (servers === undefined) return undefined;
  return (servers as Record<string, unknown>)["local-figma"];
}

function timestampNow(): string {
  return new Date().toISOString().replace(/[-:.]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

async function readOptional(path: string): Promise<{ source: string; exists: boolean; mode?: number }> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic-link configuration: ${path}`);
    }
    if (!metadata.isFile()) throw new Error(`Configuration path is not a regular file: ${path}`);
    const source = await readFile(path, "utf8");
    return { source, exists: true, mode: metadata.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source: "{}\n", exists: false };
    throw error;
  }
}

async function atomicWrite(path: string, contents: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: mode ?? 0o600, flag: "wx" });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createBackup(configPath: string, timestamp?: string): Promise<string> {
  const base = backupPathFor(configPath, timestamp ?? timestampNow());
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomUUID()}`;
    try {
      await copyFile(configPath, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to create a unique backup for ${configPath}`);
}

export async function installJsonClient(
  client: DetectedClient,
  launch: ServerLaunch,
  options: InstallJsonOptions = {},
): Promise<InstallResult> {
  if (client.strategy !== "json" || !client.configPath || !client.topLevelKey) {
    throw new Error(`${client.name} is not a JSON-configured client`);
  }
  const current = await readOptional(client.configPath);
  const desired = client.topLevelKey === "servers" ? { type: "stdio", ...launch } : launch;
  const existing = configuredServer(current.source, client.topLevelKey);
  if (existing !== undefined && isDeepStrictEqual(existing, desired)) {
    return { clientId: client.id, status: "unchanged", message: `${client.name} is already configured` };
  }
  if (existing !== undefined && !options.force) {
    throw new Error(`${client.name} already has a different 'local-figma' entry; inspect it and rerun with --force`);
  }
  const merged = mergeMcpJson(
    current.source,
    client.topLevelKey,
    launch,
    client.topLevelKey === "servers" ? { type: "stdio" } : {},
  );
  if (options.dryRun) {
    return { clientId: client.id, status: "planned", message: `Would update ${client.configPath}` };
  }
  let backupPath: string | undefined;
  if (current.exists) {
    backupPath = await createBackup(client.configPath, options.timestamp);
  }
  await atomicWrite(client.configPath, merged, current.mode);
  return {
    clientId: client.id,
    status: "installed",
    message: `Configured ${client.name} in ${client.configPath}`,
    ...(backupPath ? { backupPath } : {}),
  };
}

export async function removeJsonClient(
  client: DetectedClient,
  launch: ServerLaunch,
  options: InstallJsonOptions = {},
): Promise<InstallResult> {
  if (client.strategy !== "json" || !client.configPath || !client.topLevelKey) {
    throw new Error(`${client.name} is not a JSON-configured client`);
  }
  const current = await readOptional(client.configPath);
  const existing = current.exists ? configuredServer(current.source, client.topLevelKey) : undefined;
  if (existing === undefined) {
    return { clientId: client.id, status: "unchanged", message: `${client.name} has no local-figma entry` };
  }
  const expected = client.topLevelKey === "servers" ? { type: "stdio", ...launch } : launch;
  if (!isDeepStrictEqual(existing, expected) && !options.force) {
    throw new Error(`${client.name} has a local-figma entry not owned by this installer; rerun with --force to remove it`);
  }
  if (options.dryRun) {
    return { clientId: client.id, status: "planned", message: `Would remove local-figma from ${client.configPath}` };
  }
  const backupPath = await createBackup(client.configPath, options.timestamp);
  await atomicWrite(client.configPath, removeMcpJson(current.source, client.topLevelKey), current.mode);
  return {
    clientId: client.id,
    status: "removed",
    message: `Removed local-figma from ${client.name}`,
    backupPath,
  };
}

export const runExternalCommand: ExternalRunner = async ({ command, args }) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const maximum = 1_000_000;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > maximum) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (size > maximum) {
        reject(new Error(`${command} output exceeded the safety limit`));
      } else if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}; inspect the provider CLI locally for details`));
      } else resolve();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after 60 seconds`));
    }, 60_000);
    timer.unref();
  });
};

async function backupProviderConfig(client: DetectedClient, timestamp?: string): Promise<string | undefined> {
  if (!client.configPath) return undefined;
  const current = await readOptional(client.configPath);
  if (!current.exists) return undefined;
  return await createBackup(client.configPath, timestamp);
}

export async function installCliClient(
  client: DetectedClient,
  launch: ServerLaunch,
  options: { dryRun?: boolean; force?: boolean; timestamp?: string; runner?: ExternalRunner } = {},
): Promise<InstallResult> {
  const invocation = prepareExternalInvocation(buildCliInstallInvocation(client, launch));
  if (options.dryRun) {
    return {
      clientId: client.id,
      status: "planned",
      message: `Would run ${invocation.command} with ${invocation.args.length} fixed arguments`,
    };
  }
  if (!options.force) {
    throw new Error(
      `${client.name} may replace an existing provider-managed entry; inspect the plan and rerun setup with --force`,
    );
  }
  const backupPath = await backupProviderConfig(client, options.timestamp);
  await (options.runner ?? runExternalCommand)(invocation);
  return {
    clientId: client.id,
    status: "installed",
    message: `Configured ${client.name} through ${invocation.command}`,
    ...(backupPath ? { backupPath } : {}),
  };
}

export async function removeCliClient(
  client: DetectedClient,
  options: { dryRun?: boolean; force?: boolean; timestamp?: string; runner?: ExternalRunner } = {},
): Promise<InstallResult> {
  const invocation = prepareExternalInvocation(buildCliRemoveInvocation(client));
  if (options.dryRun) {
    return {
      clientId: client.id,
      status: "planned",
      message: `Would remove local-figma through ${invocation.command}`,
    };
  }
  if (!options.force) {
    throw new Error(`${client.name} owns its configuration through its CLI; rerun uninstall with --force after verifying the local-figma entry`);
  }
  const backupPath = await backupProviderConfig(client, options.timestamp);
  await (options.runner ?? runExternalCommand)(invocation);
  return {
    clientId: client.id,
    status: "removed",
    message: `Removed local-figma from ${client.name}`,
    ...(backupPath ? { backupPath } : {}),
  };
}

export function defaultDetectionContext(): DetectionContext {
  const resolveCommand = (command: string): string | undefined =>
    resolveCommandOnPath(command, process.env.PATH ?? "", process.platform, process.env.PATHEXT);
  return {
    platform: process.platform,
    homeDir: process.env.HOME || process.env.USERPROFILE || homedir(),
    environment: process.env,
    pathExists: existsSync,
    resolveCommand,
  };
}

export function resolveCommandOnPath(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform,
  pathExt?: string,
): string | undefined {
  const pathEntries = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32" ? (pathExt ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
        const candidates = platform === "win32"
          ? [join(entry, `${command}${extension.toLowerCase()}`), join(entry, `${command}${extension.toUpperCase()}`)]
          : [join(entry, command)];
        for (const candidate of candidates) {
          try {
            if (!statSync(candidate).isFile()) continue;
            if (platform !== "win32") accessSync(candidate, constants.X_OK);
            return candidate;
          } catch {
            continue;
          }
        }
    }
  }
  return undefined;
}

export function backupPathFor(configPath: string, timestamp: string): string {
  return join(dirname(configPath), `${basename(configPath)}.backup-${timestamp}`);
}

export interface InstallerCommandOptions {
  context?: DetectionContext;
  print?: (value: unknown, json: boolean) => void;
  runner?: ExternalRunner;
}

const CLIENT_IDS = new Set<ClientId>([
  "vscode", "copilot", "cursor", "claude-code", "claude-desktop",
  "codex", "gemini", "devin", "windsurf-legacy",
]);

function parseInstallerOptions(args: string[]) {
  const options = { yes: false, dryRun: false, force: false, json: false, clientIds: [] as ClientId[] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--client" || argument.startsWith("--client=")) {
      const value = argument === "--client" ? args[++index] : argument.slice("--client=".length);
      if (!value) throw new Error("--client requires one or more comma-separated client ids");
      for (const id of value.split(",")) {
        if (!CLIENT_IDS.has(id as ClientId)) throw new Error(`Unknown client id '${id}'`);
        if (!options.clientIds.includes(id as ClientId)) options.clientIds.push(id as ClientId);
      }
    } else throw new Error(`Unknown option '${argument}'`);
  }
  if (options.yes && options.dryRun) throw new Error("Use either --yes or --dry-run, not both");
  return options;
}

/** CLI-only dispatcher; never call from an MCP tool to mutate client settings. */
export async function runInstallerCommand(
  command: "detect" | "setup" | "uninstall",
  args: string[],
  injected: InstallerCommandOptions = {},
): Promise<number> {
  const context = injected.context ?? defaultDetectionContext();
  const print = injected.print ?? ((value: unknown, json: boolean) => {
    if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else if (Array.isArray(value)) {
      for (const item of value as DetectedClient[]) {
        process.stdout.write(`${item.id}: ${item.detected ? "detected" : "not detected"}\n`);
      }
    } else {
      const summary = value as { mode: string; results: Array<{ clientId: string; status: string; message: string }> };
      process.stdout.write(`${summary.mode === "plan" ? "Plan only; apply with --yes." : "Applied."}\n`);
      for (const result of summary.results) process.stdout.write(`${result.clientId}: ${result.status} — ${result.message}\n`);
    }
  });
  const clients = detectClients(context);
  if (command === "detect") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) throw new Error("detect only accepts --json");
    print(clients, args.includes("--json"));
    return 0;
  }
  const options = parseInstallerOptions(args);
  const selected = options.clientIds.length > 0
    ? options.clientIds.map(id => {
      const found = clients.find(client => client.id === id);
      if (!found?.detected) throw new Error(`Client '${id}' was not detected on this machine`);
      return found;
    })
    : clients.filter(client => client.detected && !(client.id === "windsurf-legacy" && clients.some(other => other.id === "devin" && other.detected)));
  const dryRun = !options.yes || options.dryRun;
  const resolved = context.resolveCommand("local-figma-mcp");
  if (command === "setup" && !dryRun && !resolved) {
    throw new Error("The global command is not on PATH. Run 'npm run install:global' first.");
  }
  const launch = buildServerLaunch(context.platform, resolved);
  const results: Array<InstallResult | { clientId: ClientId; status: "failed"; message: string }> = [];
  for (const client of selected) {
    try {
      const operationOptions = { dryRun, force: options.force, ...(injected.runner ? { runner: injected.runner } : {}) };
      const result = command === "setup"
        ? client.strategy === "json"
          ? await installJsonClient(client, launch, operationOptions)
          : await installCliClient(client, launch, operationOptions)
        : client.strategy === "json"
          ? await removeJsonClient(client, launch, operationOptions)
          : await removeCliClient(client, operationOptions);
      results.push(result);
    } catch (error) {
      results.push({ clientId: client.id, status: "failed", message: error instanceof Error ? error.message : "Installer failed" });
    }
  }
  print({ operation: command, mode: dryRun ? "plan" : "applied", changed: !dryRun && results.some(result => result.status === "installed" || result.status === "removed"), results }, options.json);
  return results.some(result => result.status === "failed") ? 1 : 0;
}
