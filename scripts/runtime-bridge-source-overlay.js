const CONNECT_START = `  /**\n   * Connect to the game's TCP interaction server with retries\n   */\n`;
const CONNECT_END = `  /**\n   * Disconnect from the game interaction server\n   */\n`;

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`${label}: expected source marker was not found`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`${label}: source marker is ambiguous`);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

const CONNECTION_BLOCK = `  /**
   * Connect to the game's TCP interaction server until the bounded readiness
   * deadline is reached. A single in-flight promise prevents reconnect storms.
   */
  private async connectToGame(
    projectPath: string,
    timeoutMs: number = this.STARTUP_CONNECT_TIMEOUT_MS
  ): Promise<boolean> {
    if (this.gameConnection.connected && this.gameConnection.socket) return true;
    if (this.gameConnectionPromise) return this.gameConnectionPromise;

    const generation = this.gameConnectionGeneration;
    this.gameConnection.projectPath = projectPath;

    const connectionPromise = (async () => {
      const result = await retryBridgeConnection(
        async (attempt: number) => {
          await this.openGameConnectionSocket(attempt, generation);
        },
        () => this.activeProcess !== null && generation === this.gameConnectionGeneration,
        {
          timeoutMs,
          retryDelayMs: this.INTERACTION_RETRY_DELAY_MS,
        },
      );

      this.gameConnectionAttempts = result.attempts;
      this.lastGameConnectionError = result.lastError;

      if (!result.connected && !result.stopped) {
        console.error(
          \`[SERVER] Game interaction bridge not ready after \${result.attempts} attempts \` +
          \`and \${result.elapsedMs}ms; later game_* calls may retry lazily. \` +
          \`Last error: \${result.lastError || 'unknown'}\`
        );
      }

      return result.connected;
    })();

    this.gameConnectionPromise = connectionPromise;
    try {
      return await connectionPromise;
    } finally {
      if (this.gameConnectionPromise === connectionPromise) {
        this.gameConnectionPromise = null;
      }
    }
  }

  private async openGameConnectionSocket(attempt: number, generation: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = createConnection({ host: '127.0.0.1', port: this.INTERACTION_PORT });

      const rejectBeforeConnect = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.once('error', rejectBeforeConnect);

      socket.once('connect', () => {
        if (generation !== this.gameConnectionGeneration || !this.activeProcess) {
          rejectBeforeConnect(new Error('Runtime changed before bridge connection completed'));
          return;
        }

        settled = true;
        socket.removeListener('error', rejectBeforeConnect);
        this.gameConnection.socket = socket;
        this.gameConnection.connected = true;
        this.gameConnection.responseBuffer = '';
        this.gameConnection.pendingRequests.clear();
        this.gameConnectionAttempts = attempt;
        this.lastGameConnectionError = null;
        this.logDebug(\`Connected to game interaction server (attempt \${attempt})\`);
        console.error(\`[SERVER] Connected to game interaction server on port \${this.INTERACTION_PORT}\`);

        socket.on('data', (data: Buffer) => {
          if (this.gameConnection.socket !== socket) return;
          this.gameConnection.responseBuffer += data.toString();
          while (this.gameConnection.responseBuffer.includes('\\n')) {
            const newlinePos = this.gameConnection.responseBuffer.indexOf('\\n');
            const line = this.gameConnection.responseBuffer.substring(0, newlinePos).trim();
            this.gameConnection.responseBuffer = this.gameConnection.responseBuffer.substring(newlinePos + 1);
            if (line.length > 0) {
              try {
                const parsed = JSON.parse(line);
                this.resolveGameResponse(parsed);
              } catch {
                this.logDebug(\`Failed to parse game response: \${line}\`);
              }
            }
          }
        });

        socket.on('close', () => {
          if (this.gameConnection.socket !== socket) return;
          this.logDebug('Game interaction connection closed');
          this.gameConnection.connected = false;
          this.gameConnection.socket = null;
          this.lastGameConnectionError = 'Connection closed';
          this.rejectAllPending({ error: 'Connection closed' });
        });

        socket.on('error', (err: Error) => {
          if (this.gameConnection.socket !== socket) return;
          this.lastGameConnectionError = err.message;
          this.logDebug(\`Game interaction socket error: \${err.message}\`);
        });

        resolve();
      });
    });
  }

  private async ensureGameConnection(timeoutMs: number = this.LAZY_RECONNECT_TIMEOUT_MS): Promise<boolean> {
    if (this.gameConnection.connected && this.gameConnection.socket) return true;
    if (!this.activeProcess || !this.gameConnection.projectPath) return false;
    return this.connectToGame(this.gameConnection.projectPath, timeoutMs);
  }

  private getGameConnectionDiagnostic(): Record<string, unknown> {
    return {
      runtimeRunning: this.activeProcess !== null,
      bridgeState: this.gameConnection.connected ? 'connected' : (this.gameConnectionPromise ? 'connecting' : 'disconnected'),
      bridgePort: this.INTERACTION_PORT,
      projectPath: this.gameConnection.projectPath,
      attempts: this.gameConnectionAttempts,
      lastError: this.lastGameConnectionError,
      recoverable: this.activeProcess !== null,
    };
  }

`;

/**
 * Apply the Hermes fork runtime-bridge overlay to the pinned upstream source.
 * Every replacement is fail-fast so an upstream source change cannot silently
 * produce an unpatched build.
 */
export function applyRuntimeBridgeOverlay(input) {
  let source = input;

  source = replaceOnce(
    source,
    `} from './utils.js';\n`,
    `} from './utils.js';\nimport { retryBridgeConnection } from './runtime-bridge-retry.js';\n`,
    'retry helper import',
  );

  source = replaceOnce(
    source,
    `  private readonly INTERACTION_PORT = 9090;\n  private readonly AUTOLOAD_NAME = 'McpInteractionServer';\n`,
    `  private readonly INTERACTION_PORT = 9090;\n` +
      `  private readonly AUTOLOAD_NAME = 'McpInteractionServer';\n` +
      `  private readonly STARTUP_CONNECT_TIMEOUT_MS = 30000;\n` +
      `  private readonly LAZY_RECONNECT_TIMEOUT_MS = 5000;\n` +
      `  private readonly INTERACTION_RETRY_DELAY_MS = 500;\n` +
      `  private gameConnectionPromise: Promise<boolean> | null = null;\n` +
      `  private gameConnectionGeneration = 0;\n` +
      `  private gameConnectionAttempts = 0;\n` +
      `  private lastGameConnectionError: string | null = null;\n`,
    'runtime bridge fields',
  );

  const start = source.indexOf(CONNECT_START);
  const end = source.indexOf(CONNECT_END, start + CONNECT_START.length);
  if (start < 0 || end < 0) throw new Error('connectToGame block markers not found');
  if (source.indexOf(CONNECT_START, start + CONNECT_START.length) >= 0) {
    throw new Error('connectToGame start marker is ambiguous');
  }
  source = source.slice(0, start) + CONNECTION_BLOCK + source.slice(end);

  source = replaceOnce(
    source,
    `  private async sendGameCommand(command: string, params: Record<string, any> = {}, timeoutMs: number = 10000): Promise<any> {\n` +
      `    if (!this.gameConnection.connected || !this.gameConnection.socket) {\n` +
      `      throw new Error('Not connected to game interaction server. Is the game running?');\n` +
      `    }\n`,
    `  private async sendGameCommand(command: string, params: Record<string, any> = {}, timeoutMs: number = 10000): Promise<any> {\n` +
      `    if (!this.gameConnection.connected || !this.gameConnection.socket) {\n` +
      `      await this.ensureGameConnection(this.LAZY_RECONNECT_TIMEOUT_MS);\n` +
      `    }\n` +
      `    if (!this.gameConnection.connected || !this.gameConnection.socket) {\n` +
      `      throw new Error(\`Not connected to game interaction server: \${JSON.stringify(this.getGameConnectionDiagnostic())}\`);\n` +
      `    }\n`,
    'sendGameCommand lazy reconnect',
  );

  source = replaceOnce(
    source,
    `    if (!this.activeProcess) return createErrorResponse('No active Godot process. Use run_project first.');\n` +
      `    if (!this.gameConnection.connected) return createErrorResponse('Not connected to game interaction server.');\n` +
      `    args = normalizeParameters(args || {});\n`,
    `    if (!this.activeProcess) return createErrorResponse('No active Godot process. Use run_project first.');\n` +
      `    args = normalizeParameters(args || {});\n`,
    'generic gameCommand pre-reconnect guard',
  );

  source = replaceOnce(
    source,
    `    if (!this.gameConnection.connected) {\n` +
      `      return createErrorResponse('Not connected to game interaction server. Wait a moment and try again.');\n` +
      `    }\n\n` +
      `    try {\n` +
      `      const response = await this.sendGameCommand('screenshot');\n`,
    `    try {\n` +
      `      const response = await this.sendGameCommand('screenshot');\n`,
    'screenshot pre-reconnect guard',
  );

  const runtimeGenerationMarker = `      // Kill any existing process\n      if (this.activeProcess) {\n`;
  const hardenedRuntimeGenerationMarker =
    `      // Inject interaction server before launching\n` +
    `      this.gameConnection.projectPath = args.projectPath;\n`;
  const runtimeGenerationPrefix =
    `      // Invalidate any connection attempt owned by an older runtime generation.\n` +
    `      this.gameConnectionGeneration += 1;\n` +
    `      this.gameConnectionPromise = null;\n` +
    `      this.gameConnectionAttempts = 0;\n` +
    `      this.lastGameConnectionError = null;\n\n`;
  if (source.includes(runtimeGenerationMarker)) {
    source = replaceOnce(
      source,
      runtimeGenerationMarker,
      runtimeGenerationPrefix + runtimeGenerationMarker,
      'new runtime generation',
    );
  } else {
    // The workstation runtime branch rejects an already-active process before
    // injection, so it has no upstream "Kill any existing process" marker.
    // Fence the generation immediately before its equivalent injection point.
    source = replaceOnce(
      source,
      hardenedRuntimeGenerationMarker,
      runtimeGenerationPrefix + hardenedRuntimeGenerationMarker,
      'new hardened runtime generation',
    );
  }

  const naturalExitMarker =
    `      process.on('exit', (code: number | null) => {\n` +
    `        this.logDebug(\`Godot process exited with code \${code}\`);\n` +
    `        this.disconnectFromGame();\n`;
  const hardenedNaturalExitMarker =
    `      godotProcess.on('exit', (code: number | null) => {\n` +
    `        this.logDebug(\`Godot process exited with code \${code}\`);\n` +
    `        if (this.activeProcess && this.activeProcess.process === godotProcess) {\n`;
  const naturalExitPrefix =
    `        this.gameConnectionGeneration += 1;\n` +
    `        this.gameConnectionPromise = null;\n`;
  if (source.includes(naturalExitMarker)) {
    source = replaceOnce(
      source,
      naturalExitMarker,
      naturalExitMarker.replace(`        this.disconnectFromGame();\n`, naturalExitPrefix + `        this.disconnectFromGame();\n`),
      'natural runtime exit invalidation',
    );
  } else {
    source = replaceOnce(
      source,
      hardenedNaturalExitMarker,
      hardenedNaturalExitMarker + naturalExitPrefix,
      'hardened natural runtime exit invalidation',
    );
  }

  source = replaceOnce(
    source,
    `    this.logDebug('Stopping active Godot process');\n    this.disconnectFromGame();\n`,
    `    this.logDebug('Stopping active Godot process');\n` +
      `    this.gameConnectionGeneration += 1;\n` +
      `    this.gameConnectionPromise = null;\n` +
      `    this.disconnectFromGame();\n`,
    'explicit stop invalidation',
  );

  const cleanupMarker =
    `  private async cleanup() {\n` +
    `    this.logDebug('Cleaning up resources');\n` +
    `    this.disconnectFromGame();\n`;
  const hardenedCleanupMarker =
    `  private async cleanup() {\n` +
    `    this.logDebug('Cleaning up resources');\n` +
    `    try {\n` +
    `      this.disconnectFromGame();\n`;
  const cleanupPrefix =
    `    this.gameConnectionGeneration += 1;\n` +
    `    this.gameConnectionPromise = null;\n`;
  if (source.includes(cleanupMarker)) {
    source = replaceOnce(
      source,
      cleanupMarker,
      cleanupMarker.replace(`    this.disconnectFromGame();\n`, cleanupPrefix + `    this.disconnectFromGame();\n`),
      'cleanup invalidation',
    );
  } else {
    source = replaceOnce(
      source,
      hardenedCleanupMarker,
      hardenedCleanupMarker.replace(`      this.disconnectFromGame();\n`, cleanupPrefix + `      this.disconnectFromGame();\n`),
      'hardened cleanup invalidation',
    );
  }

  return source;
}
