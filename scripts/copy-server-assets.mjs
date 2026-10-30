#!/usr/bin/env node
// tsc only emits compiled code, so files the server reads at runtime have to
// be copied into the staged build. Runs in build:server after tsc-alias and
// before promote-dist-server.mjs swaps dist-server.next into place; the
// desktop server bundle copies dist-server, so it picks these up as well.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = 'dist-server.next';

// Folders under server/ copied as-is to the same place in the build.
const SERVER_ASSET_DIRS = [
  'server/modules/project-templates/templates',
];

if (!fs.existsSync(path.join(rootDir, STAGE))) {
  console.error(`copy-server-assets: ${STAGE} is missing; run tsc first.`);
  process.exit(1);
}

for (const relativeDir of SERVER_ASSET_DIRS) {
  const from = path.join(rootDir, relativeDir);
  if (!fs.existsSync(from)) {
    console.error(`copy-server-assets: ${relativeDir} is missing.`);
    process.exit(1);
  }
  const to = path.join(rootDir, STAGE, relativeDir);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}
