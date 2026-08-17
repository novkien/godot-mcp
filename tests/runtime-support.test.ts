import { describe, expect, it } from 'vitest';
import {
  RuntimeLease,
  classifyGodotStderr,
  injectAutoloadEntry,
  revertAutoloadEntry,
  resolveGodotDisplayDriver,
} from '../src/runtimeSupport.js';

const AUTOLOAD_LINE = 'McpInteractionServer="*res://mcp_interaction_server.gd"';

describe('Godot project instrumentation', () => {
  it('restores a project with an existing autoload section byte-for-byte', () => {
    const original = '[application]\nconfig/name="Audit"\n\n[autoload]\nExisting="*res://existing.gd"\n';
    const injection = injectAutoloadEntry(original, AUTOLOAD_LINE);

    expect(injection.instrumentedContent).toContain(AUTOLOAD_LINE);
    expect(revertAutoloadEntry(injection.instrumentedContent, injection)).toBe(original);
  });

  it('restores a project without an autoload section byte-for-byte', () => {
    const original = '[application]\nconfig/name="Audit"\n';
    const injection = injectAutoloadEntry(original, AUTOLOAD_LINE);

    expect(injection.instrumentedContent).toContain('[autoload]');
    expect(revertAutoloadEntry(injection.instrumentedContent, injection)).toBe(original);
  });

  it('preserves unrelated edits made while the runtime is active', () => {
    const original = '[autoload]\nExisting="*res://existing.gd"\n';
    const injection = injectAutoloadEntry(original, AUTOLOAD_LINE);
    const edited = injection.instrumentedContent + '\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n';

    expect(revertAutoloadEntry(edited, injection)).toBe(
      original + '\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'
    );
  });

  it('refuses a destructive guess when its insertion was changed', () => {
    const original = '[autoload]\n';
    const injection = injectAutoloadEntry(original, AUTOLOAD_LINE);
    const edited = injection.instrumentedContent.replace(AUTOLOAD_LINE, '# removed externally');

    expect(() => revertAutoloadEntry(edited, injection)).toThrow(/Cannot safely remove/);
  });
});

describe('process-wide Godot runtime lease', () => {
  it('rejects a different owner while preserving the active target', () => {
    const lease = new RuntimeLease();

    expect(lease.tryAcquire('session-a', '/projects/a')).toEqual({ acquired: true });
    const second = lease.tryAcquire('session-b', '/projects/b');

    expect(second).toMatchObject({
      acquired: false,
      active: { ownerId: 'session-a', projectPath: '/projects/a' },
    });
    expect(lease.snapshot()?.projectPath).toBe('/projects/a');
  });

  it('allows the owner to restart and releases only for that owner', () => {
    const lease = new RuntimeLease();
    expect(lease.tryAcquire('session-a', '/projects/a')).toEqual({ acquired: true });
    expect(lease.tryAcquire('session-a', '/projects/a2')).toEqual({ acquired: true });
    expect(lease.release('session-b')).toBe(false);
    expect(lease.snapshot()?.projectPath).toBe('/projects/a2');
    expect(lease.release('session-a')).toBe(true);
    expect(lease.snapshot()).toBeNull();
  });
});

describe('Godot stderr classification', () => {
  it('does not label warnings and platform chatter as project errors', () => {
    const diagnostics = classifyGodotStderr([
      'WARNING: Display driver x11 failed, falling back to wayland.',
      '     at: setup2 (main/main.cpp:3376)',
      '',
      'libdecor-gtk-WARNING: Failed to initialize GTK',
      "Failed to load plugin 'libdecor-gtk.so': failed to init",
      '',
      'No plugins found, falling back on no decorations',
    ].join('\n'));

    expect(diagnostics.errors).toEqual([]);
    expect(diagnostics.warnings).toHaveLength(2);
    expect(diagnostics.other).toEqual(['No plugins found, falling back on no decorations']);
  });

  it('preserves an error and its source context as one diagnostic', () => {
    const diagnostics = classifyGodotStderr([
      'ERROR: Condition "thing" is true.',
      '   at: do_work (res://main.gd:12)',
      '',
      'WARNING: Secondary issue',
    ].join('\n'));

    expect(diagnostics.errors).toEqual([
      'ERROR: Condition "thing" is true.\n   at: do_work (res://main.gd:12)',
    ]);
    expect(diagnostics.warnings).toEqual(['WARNING: Secondary issue']);
  });
});

describe('Godot display driver selection', () => {
  it('prefers native Wayland for a Wayland desktop even when Xwayland DISPLAY exists', () => {
    expect(resolveGodotDisplayDriver({
      XDG_SESSION_TYPE: 'wayland',
      WAYLAND_DISPLAY: 'wayland-0',
      DISPLAY: ':0',
    }, 'linux')).toBe('wayland');
  });

  it('honors an explicit safe override', () => {
    expect(resolveGodotDisplayDriver({ GODOT_DISPLAY_DRIVER: 'headless' }, 'linux')).toBe('headless');
  });

  it('uses Godot auto-detection when no signal or override exists', () => {
    expect(resolveGodotDisplayDriver({}, 'linux')).toBeNull();
  });
});
