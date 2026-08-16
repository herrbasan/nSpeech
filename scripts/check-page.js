/** Syntax-check NUI page scripts embedded in generate.html pages.
 * Extracts <script type="nui/page">, dynamic-imports it — SyntaxError = broken.
 * Usage: node scripts/check-page.js <page.html>
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/check-page.js <page.html>'); process.exit(1); }

const html = readFileSync(file, 'utf8');
const m = html.match(/<script type="nui\/page">([\s\S]*?)<\/script>/);
if (!m) { console.error('NO PAGE SCRIPT FOUND'); process.exit(1); }

const tmp = 'logs/_page-check.mjs';
writeFileSync(tmp,
  'const element={querySelector:()=>null,querySelectorAll:()=>[]};const params={};const nui={};\n' +
  m[1] +
  '\nexport default undefined;');
try {
  await import(pathToFileURL(tmp).href);
  console.log('SYNTAX OK');
} catch (e) {
  if (e instanceof SyntaxError) { console.error('SYNTAX ERROR:', e.message); process.exit(1); }
  console.log('SYNTAX OK (non-syntax exit:', e.constructor.name + ')');
} finally {
  rmSync(tmp, { force: true });
}
