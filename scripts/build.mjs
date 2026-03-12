/**
 * Minimal build script for the Feishu plugin workspace.
 *
 * The repository currently ships TypeScript source directly but still expects
 * `pnpm build` to emit a publishable `dist/` tree. We use Node 25's native
 * TypeScript transform support to generate runnable ESM without introducing a
 * separate bundler dependency.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const repoRoot = process.cwd();
const distRoot = path.join(repoRoot, 'dist');
const sourceRoots = ['index.ts', 'src'];

/**
 * Recursively enumerate TypeScript source files under a path.
 */
async function collectTypeScriptFiles(targetPath) {
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    return targetPath.endsWith('.ts') ? [targetPath] : [];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Rewrite relative import specifiers so emitted ESM resolves `.js` files.
 */
function rewriteRelativeSpecifiers(code) {
  return code.replace(
    /((?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?|import\s*\()\s*(['"])(\.[^'"]+)\2/g,
    (fullMatch, prefix, quote, specifier) => {
      if (specifier.endsWith('.json') || specifier.endsWith('.js') || specifier.endsWith('.mjs')) {
        return `${prefix}${quote}${specifier}${quote}`;
      }
      if (specifier.endsWith('.ts')) {
        return `${prefix}${quote}${specifier.slice(0, -3)}.js${quote}`;
      }
      return `${prefix}${quote}${specifier}.js${quote}`;
    },
  );
}

/**
 * Transform a TypeScript file into runnable ESM and write it into `dist/`.
 */
async function emitFile(sourceFilePath) {
  const sourceCode = await readFile(sourceFilePath, 'utf8');
  const transformedCode = stripTypeScriptTypes(sourceCode, {
    mode: 'transform',
    sourceMap: false,
    sourceUrl: sourceFilePath,
  });
  const rewrittenCode = rewriteRelativeSpecifiers(transformedCode);
  const relativePath = path.relative(repoRoot, sourceFilePath);
  const outputRelativePath = relativePath.replace(/\.ts$/u, '.js');
  const outputPath = path.join(distRoot, outputRelativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rewrittenCode, 'utf8');
  return outputRelativePath;
}

async function main() {
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });

  const sourceFilePaths = [];
  for (const sourceRoot of sourceRoots) {
    sourceFilePaths.push(...(await collectTypeScriptFiles(path.join(repoRoot, sourceRoot))));
  }

  const emittedFiles = [];
  for (const sourceFilePath of sourceFilePaths) {
    emittedFiles.push(await emitFile(sourceFilePath));
  }

  // Publish metadata so package managers treat the emitted tree as ESM.
  await writeFile(
    path.join(distRoot, 'package.json'),
    JSON.stringify(
      {
        type: 'module',
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`Built ${emittedFiles.length} file(s) into dist/`);
}

await main();
