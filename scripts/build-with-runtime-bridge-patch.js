import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { applyRuntimeBridgeOverlay } from './runtime-bridge-source-overlay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'src', 'index.ts');
const originalSource = readFileSync(sourcePath, 'utf8');
const patchedSource = applyRuntimeBridgeOverlay(originalSource);

if (patchedSource === originalSource) {
  throw new Error('Runtime bridge overlay produced no source change');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

try {
  // The fork keeps the upstream TypeScript source byte-identical for easy rebases,
  // but every built runtime is compiled from the fail-fast Hermes bridge overlay.
  writeFileSync(sourcePath, patchedSource, 'utf8');
  const tsc = process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', '.bin', 'tsc.cmd')
    : path.join(repoRoot, 'node_modules', '.bin', 'tsc');
  run(tsc, []);
} finally {
  writeFileSync(sourcePath, originalSource, 'utf8');
}

await import('./build.js');
