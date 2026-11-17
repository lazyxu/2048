import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest']) {
  await cp(file, `dist/${file}`);
}
for (const directory of ['src', 'icons']) {
  await cp(directory, `dist/${directory}`, { recursive: true });
}
await writeFile('dist/.nojekyll', '');
console.log('Static 2048 PWA prepared in dist/');
