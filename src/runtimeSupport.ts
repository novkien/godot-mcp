/**
 * Runtime-safety helpers shared by stdio and HTTP transports.
 *
 * These helpers are deliberately independent from the MCP SDK so the project
 * instrumentation and cross-session lease semantics can be regression-tested
 * without starting Godot.
 */

export interface AutoloadInjection {
  originalContent: string;
  instrumentedContent: string;
  insertedText: string;
}

export function injectAutoloadEntry(
  originalContent: string,
  autoloadLine: string
): AutoloadInjection {
  if (originalContent.includes(autoloadLine)) {
    throw new Error(`Autoload entry already exists: ${autoloadLine}`);
  }

  let insertedText: string;
  let instrumentedContent: string;

  if (originalContent.includes('[autoload]')) {
    insertedText = `\n\n${autoloadLine}`;
    instrumentedContent = originalContent.replace(
      '[autoload]',
      `[autoload]${insertedText}`
    );
  } else {
    insertedText = `\n[autoload]\n\n${autoloadLine}\n`;
    instrumentedContent = originalContent + insertedText;
  }

  return {
    originalContent,
    instrumentedContent,
    insertedText,
  };
}

/**
 * Revert only the exact instrumentation added by injectAutoloadEntry.
 *
 * If project.godot stayed untouched while Godot was running, restoring the
 * original bytes guarantees byte-for-byte identity. If another actor edited
 * the file, remove only our exact insertion and preserve those other edits.
 */
export function revertAutoloadEntry(
  currentContent: string,
  injection: AutoloadInjection
): string {
  if (currentContent === injection.instrumentedContent) {
    return injection.originalContent;
  }

  const insertionIndex = currentContent.indexOf(injection.insertedText);
  if (insertionIndex === -1) {
    throw new Error(
      'Cannot safely remove MCP autoload instrumentation because the injected text changed'
    );
  }

  return (
    currentContent.slice(0, insertionIndex) +
    currentContent.slice(insertionIndex + injection.insertedText.length)
  );
}

export interface RuntimeLeaseSnapshot {
  ownerId: string;
  projectPath: string;
  acquiredAt: string;
}

/** Process-wide lease preventing separate HTTP MCP sessions from cross-binding. */
export class RuntimeLease {
  private active: RuntimeLeaseSnapshot | null = null;

  tryAcquire(ownerId: string, projectPath: string):
    | { acquired: true }
    | { acquired: false; active: RuntimeLeaseSnapshot } {
    if (this.active && this.active.ownerId !== ownerId) {
      return { acquired: false, active: { ...this.active } };
    }

    this.active = {
      ownerId,
      projectPath,
      acquiredAt: new Date().toISOString(),
    };
    return { acquired: true };
  }

  release(ownerId: string): boolean {
    if (!this.active || this.active.ownerId !== ownerId) return false;
    this.active = null;
    return true;
  }

  snapshot(): RuntimeLeaseSnapshot | null {
    return this.active ? { ...this.active } : null;
  }
}

export interface GodotStderrDiagnostics {
  errors: string[];
  warnings: string[];
  other: string[];
}

/**
 * Godot writes errors, warnings, and platform chatter to stderr. Keep the raw
 * stream, but expose severity-specific arrays so stderr is not mislabeled as
 * project errors in QA evidence.
 */
export function classifyGodotStderr(stderr: string): GodotStderrDiagnostics {
  const result: GodotStderrDiagnostics = { errors: [], warnings: [], other: [] };
  let active: 'errors' | 'warnings' | 'other' | null = null;

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      active = null;
      continue;
    }

    if (/^(?:SCRIPT )?ERROR:/.test(trimmed)) {
      active = 'errors';
      result.errors.push(line);
      continue;
    }
    if (/WARNING:/.test(trimmed)) {
      active = 'warnings';
      result.warnings.push(line);
      continue;
    }

    if (active) {
      const bucket = result[active];
      bucket[bucket.length - 1] += `\n${line}`;
    } else {
      result.other.push(line);
    }
  }

  return result;
}

export function resolveGodotDisplayDriver(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | null {
  const configured = env.GODOT_DISPLAY_DRIVER?.trim();
  if (configured) {
    if (!/^[A-Za-z0-9_-]+$/.test(configured)) {
      throw new Error(`Invalid GODOT_DISPLAY_DRIVER: ${configured}`);
    }
    return configured;
  }

  if (
    platform === 'linux' &&
    env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' &&
    env.WAYLAND_DISPLAY
  ) {
    return 'wayland';
  }

  return null;
}
