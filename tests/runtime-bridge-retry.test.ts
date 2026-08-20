import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { retryBridgeConnection } from '../src/runtime-bridge-retry.js';
import { applyRuntimeBridgeOverlay } from '../scripts/runtime-bridge-source-overlay.js';

describe('retryBridgeConnection', () => {
  it('recovers when the bridge becomes ready after the legacy seven-second window', async () => {
    let nowMs = 0;
    let calls = 0;

    const result = await retryBridgeConnection(
      async () => {
        calls += 1;
        if (nowMs < 15_000) throw new Error('ECONNREFUSED');
      },
      () => true,
      {
        timeoutMs: 30_000,
        retryDelayMs: 5_000,
        now: () => nowMs,
        sleep: async ms => { nowMs += ms; },
      },
    );

    expect(result.connected).toBe(true);
    expect(result.elapsedMs).toBe(15_000);
    expect(result.attempts).toBe(4);
    expect(calls).toBe(4);
    expect(result.lastError).toBeNull();
  });

  it('stops retrying when the owning runtime is no longer active', async () => {
    let nowMs = 0;
    let active = true;

    const result = await retryBridgeConnection(
      async () => {
        active = false;
        throw new Error('runtime exited');
      },
      () => active,
      {
        timeoutMs: 30_000,
        retryDelayMs: 500,
        now: () => nowMs,
        sleep: async ms => { nowMs += ms; },
      },
    );

    expect(result.connected).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.stopped).toBe(true);
    expect(result.lastError).toBe('runtime exited');
  });

  it('honors the configured deadline when the bridge never becomes ready', async () => {
    let nowMs = 0;

    const result = await retryBridgeConnection(
      async () => { throw new Error('ECONNREFUSED'); },
      () => true,
      {
        timeoutMs: 7_000,
        retryDelayMs: 500,
        now: () => nowMs,
        sleep: async ms => { nowMs += ms; },
      },
    );

    expect(result.connected).toBe(false);
    expect(result.elapsedMs).toBe(7_000);
    expect(result.lastError).toBe('ECONNREFUSED');
  });
});

describe('GodotServer runtime bridge overlay contract', () => {
  const upstreamSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = applyRuntimeBridgeOverlay(upstreamSource);

  it('adds condition-driven startup and lazy reconnect to the pinned upstream source', () => {
    expect(source).toContain("from './runtime-bridge-retry.js'");
    expect(source).toContain('STARTUP_CONNECT_TIMEOUT_MS = 30000');
    expect(source).toContain('LAZY_RECONNECT_TIMEOUT_MS = 5000');
    expect(source).toContain('await this.ensureGameConnection(this.LAZY_RECONNECT_TIMEOUT_MS)');
    expect(source).toContain('getGameConnectionDiagnostic()');
  });

  it('removes the permanent disconnected fast-fail before generic game commands can reconnect', () => {
    const start = source.indexOf('private async gameCommand(');
    const end = source.indexOf('private async headlessOp(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const gameCommandSource = source.slice(start, end);
    expect(gameCommandSource).not.toContain("if (!this.gameConnection.connected) return createErrorResponse('Not connected to game interaction server.')");
  });

  it('fails closed when upstream markers drift instead of silently building without the fix', () => {
    const drifted = upstreamSource.replace(
      "   * Connect to the game's TCP interaction server with retries",
      "   * Upstream changed this bridge block",
    );
    expect(() => applyRuntimeBridgeOverlay(drifted)).toThrow(/connectToGame block markers not found/);
  });
});
