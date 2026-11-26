// CI doctor: load every native (platform-specific) binary the later steps depend on and say
// which one is broken. Without this, a missing or unloadable binary shows up as a confusing
// failure deep inside `tsc`, `vitest` or `tsx`.
//   typescript 7  -> native `tsc` from @typescript/typescript-<platform>-<arch>  (typecheck, build)
//   esbuild       -> @esbuild/<platform>-<arch>                                  (tsx: example, child-process tests)
//   rolldown      -> @rolldown/binding-<platform>-<arch>                         (vite: vitest)
// Usage: node scripts/check-native.mjs
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
console.log(`node ${process.version} on ${process.platform}-${process.arch}`);

let failed = 0;
async function check(name, fn) {
  try {
    console.log(`ok   ${name}: ${await fn()}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

await check('typescript (native tsc)', () => {
  // `typescript` does not export its bin path, so go through package.json.
  const tscBin = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  return execFileSync(process.execPath, [tscBin, '--version'], { encoding: 'utf8', timeout: 60_000 }).trim();
});

await check('esbuild', async () => {
  const esbuild = await import('esbuild');
  const out = esbuild.transformSync('const a: number = 1;', { loader: 'ts' }).code.trim();
  return `${esbuild.version} -> ${out}`;
});

await check('rolldown', async () => {
  const { rolldown, VERSION } = await import('rolldown');
  if (typeof rolldown !== 'function') throw new Error('rolldown() export missing');
  return VERSION ?? 'loaded';
});

if (failed) {
  console.error(`${failed} native check(s) failed. Is the lock file missing the package for ${process.platform}-${process.arch}?`);
  process.exit(1);
}
