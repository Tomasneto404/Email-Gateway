// Authored by Tomás Neto (TN 2026)
// Smoke check for the runtime image, run by CI as the image's non-root user:
//   docker run --rm -i --entrypoint node <image> --input-type=module - < scripts/check-runtime-image.mjs
// Catches files the `node` user cannot read (e.g. a restrictive umask on the build runner) and
// runtime dependencies, including native modules, that fail to load. It never bootstraps the app,
// so no database, Redis or SMTP is needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

assert.notEqual(process.getuid(), 0, 'Run the image check as the non-root runtime user');

const root = '/app';

function checkReadable(directory) {
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) checkReadable(file);
    else fs.accessSync(file, fs.constants.R_OK);
  }
}

for (const directory of ['dist', 'ui/dist']) checkReadable(path.join(root, directory));
fs.readFileSync(path.join(root, 'package.json'));
fs.accessSync(path.join(root, 'ui/dist/index.html'), fs.constants.R_OK);
fs.accessSync(path.join(root, 'dist/docs-assets/scalar.js'), fs.constants.R_OK);

// Load both module graphs (api + worker) without calling bootstrap(): resolves every runtime
// dependency, including argon2's native binding and the generated Prisma client.
const require = createRequire(path.join(root, 'package.json'));
require('reflect-metadata');
for (const mod of ['dist/api.module.js', 'dist/worker.module.js']) require(path.join(root, mod));
console.log(`Runtime files and dependencies verified as UID ${process.getuid()}`);
