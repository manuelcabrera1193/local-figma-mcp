import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AUTH_CSS, AUTH_SCRIPT, AUTH_FAVICON, renderSetupPage, renderAuthMessage } from './auth-ui.js';

const DEFAULT_SCOPES = ['file_content:read', 'file_metadata:read'];
const SESSION_TTL = 10 * 60_000;
interface Credentials { clientId: string; clientSecret: string; redirectUri?: string }
interface Tokens { accessToken: string; refreshToken: string; expiresAt: number; userId?: string; scopes: string[] }
interface Connection { pid: number; sessionId: string; status: 'setup_required' | 'authorization_required'; url: string; redirectUri: string; expiresAt: number }
export interface AuthOptions {
  root: string;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  port?: number;
  tokenUrl?: string;
  authorizeUrl?: string;
  refreshUrl?: string;
}
export interface AuthStatus {
  mode: 'personal-token' | 'oauth' | 'none';
  configured: boolean;
  authenticated: boolean;
  pending: boolean;
  verified?: boolean;
  expiresAt?: string;
  userId?: string;
  scopes: string[];
  redirectUri?: string;
  instructions?: string;
}
export interface ConnectResult {
  status: 'authenticated' | 'authorization_required' | 'setup_required';
  authorizationUrl?: string;
  setupUrl?: string;
  redirectUri?: string;
  expiresAt?: string;
  warning?: string;
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', detached: true });
    child.once('error', () => reject(new Error('No se pudo abrir el navegador.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)); }
function equalSecret(a: string, b: string): boolean {
  const first = Buffer.from(a); const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
function validCredentials(value: Credentials): Credentials {
  if (typeof value.clientId !== 'string' || !value.clientId.trim() || value.clientId.length > 512 || /[\r\n:]/.test(value.clientId)) throw new Error('Client ID de OAuth inválido.');
  if (typeof value.clientSecret !== 'string' || !value.clientSecret.trim() || value.clientSecret.length > 4096 || /[\r\n]/.test(value.clientSecret)) throw new Error('Client Secret de OAuth inválido.');
  if (value.redirectUri) {
    let url: URL;
    try { url = new URL(value.redirectUri); } catch { throw new Error('Callback OAuth inválido.'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/oauth/callback' || url.search || url.hash || !url.port) throw new Error('El callback debe ser http://127.0.0.1:PUERTO/oauth/callback.');
  }
  return { clientId: value.clientId.trim(), clientSecret: value.clientSecret.trim(), ...(value.redirectUri ? { redirectUri: value.redirectUri } : {}) };
}

function validPersonalToken(input: string): string {
  if (typeof input !== 'string') throw new Error('Token personal inválido.');
  const token = input.trim();
  if (!token || token.length > 4096 || /\s/.test(token)) throw new Error('Token personal inválido. Usa el token completo, sin espacios ni saltos de línea.');
  return token;
}

/** Figma REST OAuth. Account passwords never enter this class or its local setup panel. */
export class AuthManager {
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly opener: (url: string) => Promise<void>;
  private server?: Server;
  private origin?: string;
  private sessionId = randomUUID();
  private setupCsrf = randomBytes(32).toString('base64url');
  private pending?: { state: string; verifier: string; expiresAt: number; authorizationUrl: string; redirectUri: string };
  private expiryTimer?: NodeJS.Timeout;
  private startPromise?: Promise<void>;
  private connectPromise?: Promise<ConnectResult>;

  constructor(private readonly options: AuthOptions) {
    this.directory = join(options.root, 'auth');
    this.fetcher = options.fetch ?? fetch;
    this.opener = options.openBrowser ?? defaultOpenBrowser;
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('Puerto OAuth inválido.');
    for (const candidate of [options.tokenUrl, options.authorizeUrl, options.refreshUrl]) {
      if (!candidate) continue;
      const url = new URL(candidate);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Endpoint OAuth inseguro.');
      if (url.username || url.password || url.hash) throw new Error('Endpoint OAuth inválido.');
    }
  }
  private file(name: string): string { return join(this.directory, name); }
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('El directorio OAuth no puede ser un enlace simbólico.');
    await chmod(this.directory, 0o700);
  }
  private async read<T>(name: string): Promise<T | undefined> {
    try {
      const path = this.file(name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64_000) throw new Error('Archivo OAuth inválido.');
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('No se pudo leer la configuración OAuth local.');
    }
  }
  private async write(name: string, value: unknown): Promise<void> {
    await this.ensureDirectory();
    const temporary = this.file(`.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file(name));
      await chmod(this.file(name), 0o600);
    } finally { await rm(temporary, { force: true }); }
  }
  private async credentials(): Promise<Credentials | undefined> {
    if (process.env.FIGMA_CLIENT_ID || process.env.FIGMA_CLIENT_SECRET) {
      if (!process.env.FIGMA_CLIENT_ID || !process.env.FIGMA_CLIENT_SECRET) throw new Error('Configura FIGMA_CLIENT_ID y FIGMA_CLIENT_SECRET juntos.');
      return validCredentials({ clientId: process.env.FIGMA_CLIENT_ID, clientSecret: process.env.FIGMA_CLIENT_SECRET, ...(process.env.FIGMA_REDIRECT_URI ? { redirectUri: process.env.FIGMA_REDIRECT_URI } : {}) });
    }
    const saved = await this.read<Credentials>('credentials.json');
    return saved ? validCredentials(saved) : undefined;
  }
  private async personalToken(): Promise<{ token: string; source: 'environment' | 'environment-file' | 'local' } | undefined> {
    if (process.env.FIGMA_TOKEN?.trim()) return { token: validPersonalToken(process.env.FIGMA_TOKEN), source: 'environment' };
    if (process.env.FIGMA_TOKEN_FILE?.trim()) {
      try {
        const path = process.env.FIGMA_TOKEN_FILE;
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8192 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) throw new Error('Archivo de token no privado.');
        return { token: validPersonalToken(await readFile(path, 'utf8')), source: 'environment-file' };
      } catch { throw new Error('FIGMA_TOKEN_FILE debe señalar un archivo privado del usuario, sin enlaces simbólicos y con permisos 600.'); }
    }
    const saved = await this.read<{ token: string }>('personal-token.json');
    return saved ? { token: validPersonalToken(saved.token), source: 'local' } : undefined;
  }
  async setPersonalToken(input: string): Promise<void> {
    const token = validPersonalToken(input);
    await this.withRefreshLock(async () => {
      await this.write('personal-token.json', { token });
      await rm(this.file('connection.json'), { force: true });
    });
    this.pending = undefined;
  }
  private async activeConnection(): Promise<Connection | undefined> {
    const connection = await this.read<Connection>('connection.json');
    if (!connection || !Number.isFinite(connection.expiresAt) || connection.expiresAt <= Date.now() || !Number.isInteger(connection.pid)) return undefined;
    try { process.kill(connection.pid, 0); } catch { return undefined; }
    return connection;
  }
  async status(): Promise<AuthStatus> {
    const personal = await this.personalToken();
    if (personal) return {
      mode: 'personal-token', configured: true, authenticated: true, pending: false, verified: false,
      scopes: [],
      instructions: personal.source === 'environment'
        ? 'Token personal configurado mediante FIGMA_TOKEN. Su validez y permisos se comprueban al llamar a Figma. Para desconectar, elimina también esa variable del entorno del servidor.'
        : personal.source === 'environment-file'
          ? 'Token personal configurado mediante FIGMA_TOKEN_FILE. Su validez y permisos se comprueban al llamar a Figma. Para desconectar, elimina también esa variable del entorno del servidor.'
          : 'Token personal guardado localmente. Su validez y permisos se comprueban al llamar a Figma.',
    };
    const credentials = await this.credentials();
    const tokens = await this.read<Tokens>('tokens.json');
    const connection = await this.activeConnection();
    const expiresAt = tokens && Number.isFinite(tokens.expiresAt) ? new Date(tokens.expiresAt).toISOString() : undefined;
    return {
      mode: credentials ? 'oauth' : 'none',
      configured: !!credentials,
      authenticated: !!credentials && !!tokens?.accessToken && tokens.expiresAt > Date.now(),
      pending: !!connection,
      scopes: tokens?.scopes ?? [...DEFAULT_SCOPES],
      ...(expiresAt ? { expiresAt } : {}),
      ...(tokens?.userId ? { userId: tokens.userId } : {}),
      ...(connection?.redirectUri || credentials?.redirectUri ? { redirectUri: connection?.redirectUri ?? credentials?.redirectUri } : {}),
      ...(!credentials ? { instructions: 'Usa Conectar para guardar tu token personal en el panel local, o configura una aplicación OAuth en https://www.figma.com/developers/apps. No introduzcas tu contraseña de Figma.' } : {}),
    };
  }
  async configure(input: Credentials): Promise<void> {
    const credentials = validCredentials(input);
    await this.withRefreshLock(async () => {
      await this.write('credentials.json', credentials);
      await rm(this.file('tokens.json'), { force: true });
      await rm(this.file('connection.json'), { force: true });
    });
    this.pending = undefined;
    await this.clearOwnConnection();
  }
  private async start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const credentials = await this.credentials();
      const configuredPort = credentials?.redirectUri ? Number(new URL(credentials.redirectUri).port) : undefined;
      const port = configuredPort ?? this.options.port ?? 3847;
      const server = createServer((request, response) => { void this.handle(request, response).catch(() => this.respond(response, 500, 'No se pudo completar la operación OAuth.')); });
      server.requestTimeout = 10_000; server.headersTimeout = 10_000;
      server.maxConnections = 16;
      await new Promise<void>((resolve, reject) => {
        const onError = () => reject(new Error(`No se pudo iniciar el callback OAuth en 127.0.0.1:${port}. El puerto puede estar ocupado.`));
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
      });
      this.server = server;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Dirección del callback OAuth inválida.');
      this.origin = `http://127.0.0.1:${address.port}`;
      this.expiryTimer = setTimeout(() => { void this.close(); }, SESSION_TTL);
      this.expiryTimer.unref();
    })().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }
  async connect(options: { openBrowser?: boolean } = {}): Promise<ConnectResult> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect(options).finally(() => { this.connectPromise = undefined; });
    return this.connectPromise;
  }
  private async doConnect(options: { openBrowser?: boolean }): Promise<ConnectResult> {
    const status = await this.status();
    if (status.authenticated) return { status: 'authenticated', ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}) };
    const active = await this.activeConnection();
    if (active) return {
      status: active.status,
      ...(active.status === 'setup_required' ? { setupUrl: active.url } : { authorizationUrl: active.url }),
      redirectUri: active.redirectUri,
      expiresAt: new Date(active.expiresAt).toISOString(),
    };
    await this.start();
    const credentials = await this.credentials();
    const redirectUri = credentials?.redirectUri ?? `${this.origin}/oauth/callback`;
    let result: ConnectResult;
    if (!credentials) {
      const setupUrl = `${this.origin}/setup?session=${encodeURIComponent(this.setupCsrf)}`;
      result = { status: 'setup_required', setupUrl, redirectUri };
      await this.saveConnection('setup_required', setupUrl, redirectUri);
    } else {
      result = await this.beginAuthorization(credentials, redirectUri);
    }
    if (options.openBrowser !== false) {
      try { await this.opener(result.authorizationUrl ?? result.setupUrl!); }
      catch { result.warning = 'No se pudo abrir el navegador. Abre manualmente el enlace devuelto.'; }
    }
    return result;
  }
  private async saveConnection(status: Connection['status'], url: string, redirectUri: string): Promise<void> {
    await this.write('connection.json', { pid: process.pid, sessionId: this.sessionId, status, url, redirectUri, expiresAt: Date.now() + SESSION_TTL } satisfies Connection);
  }
  private async beginAuthorization(credentials: Credentials, redirectUri: string): Promise<ConnectResult> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const url = new URL(this.options.authorizeUrl ?? 'https://www.figma.com/oauth');
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', DEFAULT_SCOPES.join(' '));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    this.pending = { state, verifier, redirectUri, authorizationUrl: url.href, expiresAt: Date.now() + SESSION_TTL };
    await this.saveConnection('authorization_required', url.href, redirectUri);
    return { status: 'authorization_required', authorizationUrl: url.href, redirectUri, expiresAt: new Date(this.pending.expiresAt).toISOString() };
  }
  private respond(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
    if (response.headersSent || response.destroyed) return;
    if (status >= 400 && contentType.startsWith('text/plain')) {
      body = renderAuthMessage({ kind: 'error', title: 'No se pudo completar la conexión', message: body, note: 'Tu credencial no se muestra en esta página.' });
      contentType = 'text/html; charset=utf-8';
    }
    response.writeHead(status, {
      // Chrome derives form-navigation Origin from this policy. no-referrer
      // turns same-origin POSTs into Origin:null, which we correctly reject.
      'Content-Type': contentType, 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(body);
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.origin || request.headers.host !== new URL(this.origin).host) return this.respond(response, 403, 'Host no permitido.');
    const url = new URL(request.url ?? '/', this.origin);
    if (request.method === 'GET' && url.pathname === '/assets/auth.css') return this.respond(response, 200, AUTH_CSS, 'text/css; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/assets/auth.js') return this.respond(response, 200, AUTH_SCRIPT, 'text/javascript; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/assets/favicon.svg') return this.respond(response, 200, AUTH_FAVICON, 'image/svg+xml');
    if (request.method === 'GET' && url.pathname === '/setup') {
      if (url.searchParams.getAll('session').length !== 1 || !equalSecret(url.searchParams.get('session') ?? '', this.setupCsrf)) return this.respond(response, 403, 'Sesión local inválida.');
      const redirectUri = `${this.origin}/oauth/callback`;
      const html = renderSetupPage({ csrf: this.setupCsrf, redirectUri });
      return this.respond(response, 200, html, 'text/html; charset=utf-8');
    }
    if (request.method === 'POST' && (url.pathname === '/setup' || url.pathname === '/personal-token')) {
      if (request.headers.origin !== this.origin) return this.respond(response, 403, 'Origen no permitido.');
      if (!(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return this.respond(response, 415, 'Formato no permitido.');
      let text = '';
      for await (const chunk of request) {
        text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (Buffer.byteLength(text) > 16_384) return this.respond(response, 413, 'Formulario demasiado grande.');
      }
      const form = new URLSearchParams(text);
      if (form.getAll('csrf').length !== 1 || !equalSecret(form.get('csrf') ?? '', this.setupCsrf)) return this.respond(response, 403, 'Sesión local inválida.');
      if (url.pathname === '/personal-token') {
        if (form.getAll('personalToken').length !== 1) return this.respond(response, 400, 'Falta el token personal.');
        try { await this.setPersonalToken(form.get('personalToken') ?? ''); }
        catch { return this.respond(response, 400, 'No se pudo guardar el token personal. Revisa su formato.'); }
        this.setupCsrf = randomBytes(32).toString('base64url');
        return this.respond(response, 200, renderAuthMessage({kind:'success',title:'Token personal guardado localmente',message:'Tu conexión está preparada. Su validez y sus permisos se comprobarán al consultar un archivo de Figma.'}), 'text/html; charset=utf-8');
      }
      if (form.getAll('clientId').length !== 1 || form.getAll('clientSecret').length !== 1) return this.respond(response, 400, 'Credenciales OAuth inválidas.');
      try { await this.configure({ clientId: form.get('clientId') ?? '', clientSecret: form.get('clientSecret') ?? '', redirectUri: `${this.origin}/oauth/callback` }); }
      catch { return this.respond(response, 400, 'No se pudo guardar la configuración OAuth.'); }
      const credentials = await this.credentials();
      if (!credentials) return this.respond(response, 400, 'Faltan credenciales OAuth.');
      const result = await this.beginAuthorization(credentials, credentials.redirectUri!);
      this.setupCsrf = randomBytes(32).toString('base64url');
      // Keep the form response local. A cross-origin 303 inherits form-action
      // 'self' and Chromium correctly blocks it; explicit navigation does not.
      return this.respond(response, 200, renderAuthMessage({kind:'authorize',title:'Aplicación OAuth configurada',message:'Los datos de tu aplicación se guardaron en este equipo. Continúa en la autorización oficial de Figma para conectar tu cuenta.',authorizationUrl:result.authorizationUrl!}), 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/oauth/callback') {
      const pending = this.pending;
      const connection = await this.activeConnection();
      const state = url.searchParams.get('state') ?? '';
      if (!pending || connection?.sessionId !== this.sessionId || pending.expiresAt <= Date.now() || url.searchParams.getAll('state').length !== 1 || !equalSecret(state, pending.state) || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1) return this.respond(response, 400, 'Callback OAuth inválido o vencido. Inicia Conectar de nuevo.');
      if (url.searchParams.has('error')) {
        this.pending = undefined; await this.clearOwnConnection();
        return this.respond(response, 400, 'La autorización fue rechazada. Puedes iniciar Conectar de nuevo.');
      }
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) return this.respond(response, 400, 'Falta el código de autorización.');
      this.pending = undefined;
      const credentials = await this.credentials();
      if (!credentials) return this.respond(response, 400, 'Falta la configuración OAuth.');
      try {
        await this.withRefreshLock(async () => {
          if ((await this.activeConnection())?.sessionId !== this.sessionId) throw new Error('La conexión OAuth fue cancelada.');
          await this.clearOwnConnection();
          const data = await this.requestToken(this.options.tokenUrl ?? 'https://api.figma.com/v1/oauth/token', credentials, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier }));
          await this.write('tokens.json', this.normalizeToken(data));
        });
        return this.respond(response, 200, renderAuthMessage({kind:'success',title:'Figma conectado',message:'Tu cuenta ya está conectada. Vuelve a tu asistente para consultar tus diseños.'}), 'text/html; charset=utf-8');
      } catch { return this.respond(response, 502, 'Figma no pudo completar la autorización. Revisa la aplicación y vuelve a conectar.'); }
    }
    this.respond(response, 404, 'Ruta no disponible.');
  }
  private async requestToken(endpoint: string, credentials: Credentials, body: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.fetcher(endpoint, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
    catch { throw new Error('No se pudo contactar con la autorización de Figma.'); }
    if (!response.ok) throw new Error(`La autorización de Figma falló (HTTP ${response.status}). Vuelve a conectar.`);
    const text = await response.text();
    if (text.length > 64_000) throw new Error('Respuesta OAuth demasiado grande.');
    try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error('Respuesta OAuth inválida.'); }
  }
  private normalizeToken(data: Record<string, unknown>, previous?: Tokens): Tokens {
    if (!data || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192 || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 365 * 86400) throw new Error('Respuesta OAuth incompleta.');
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : previous?.refreshToken;
    if (!refreshToken || refreshToken.length > 8192) throw new Error('Falta el token de renovación OAuth.');
    const userId = typeof data.user_id_string === 'string' ? data.user_id_string : previous?.userId;
    return { accessToken: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000, ...(userId ? { userId } : {}), scopes: previous?.scopes ?? [...DEFAULT_SCOPES] };
  }
  private async withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lock = this.file('refresh.lock');
    const deadline = Date.now() + 20_000;
    let acquired = false;
    while (!acquired) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('No se pudo bloquear el estado OAuth.');
        try { if (Date.now() - (await stat(lock)).mtimeMs > 60_000) { await rm(lock, { recursive: true, force: true }); continue; } } catch { continue; }
        if (Date.now() > deadline) throw new Error('Otra conexión OAuth está ocupada. Intenta de nuevo.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
  async getAccessToken(): Promise<string> {
    const personal = await this.personalToken();
    if (personal) return personal.token;
    return this.getOAuthAccessToken();
  }
  async getRequestHeaders(): Promise<Record<string, string>> {
    const personal = await this.personalToken();
    if (personal) return { 'X-Figma-Token': personal.token };
    return { Authorization: `Bearer ${await this.getOAuthAccessToken()}` };
  }
  private async getOAuthAccessToken(): Promise<string> {
    const current = await this.read<Tokens>('tokens.json');
    if (current?.accessToken && current.expiresAt > Date.now() + 30_000) return current.accessToken;
    return this.withRefreshLock(async () => {
      const tokens = await this.read<Tokens>('tokens.json');
      if (tokens?.accessToken && tokens.expiresAt > Date.now() + 30_000) return tokens.accessToken;
      const credentials = await this.credentials();
      if (!credentials || !tokens?.refreshToken) throw new Error('Figma no está conectado. Ejecuta figma_connect o local-figma-mcp login.');
      const endpoint = this.options.refreshUrl ?? (this.options.tokenUrl ? new URL('./refresh', this.options.tokenUrl).href : 'https://api.figma.com/v1/oauth/refresh');
      const data = await this.requestToken(endpoint, credentials, new URLSearchParams({ refresh_token: tokens.refreshToken }));
      const refreshed = this.normalizeToken(data, tokens);
      await this.write('tokens.json', refreshed);
      return refreshed.accessToken;
    });
  }
  private async clearOwnConnection(): Promise<void> {
    const saved = await this.read<Connection>('connection.json');
    if (saved?.sessionId === this.sessionId) await rm(this.file('connection.json'), { force: true });
  }
  async disconnect(): Promise<void> {
    this.pending = undefined;
    await this.withRefreshLock(async () => { await rm(this.file('tokens.json'), { force: true }); await rm(this.file('personal-token.json'), { force: true }); await rm(this.file('connection.json'), { force: true }); });
  }
  async close(): Promise<void> {
    this.pending = undefined;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    await this.clearOwnConnection();
    const server = this.server; this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    this.origin = undefined;
  }
}
