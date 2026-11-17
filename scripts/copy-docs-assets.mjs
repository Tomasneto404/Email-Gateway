// Authored by Tomás Neto (TN 2026)
// Copies the self-hosted Scalar bundle next to the compiled app (dist/docs-assets/scalar.js).
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), 'node_modules/@scalar/api-reference/dist/browser/standalone.js');
mkdirSync('dist/docs-assets', { recursive: true });
copyFileSync(src, 'dist/docs-assets/scalar.js');
console.log('copied Scalar bundle → dist/docs-assets/scalar.js');
