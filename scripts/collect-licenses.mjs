import fs from 'node:fs/promises';
import path from 'node:path';
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const output = 'third-party-licenses';
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const records = [];
for (const [location, entry] of Object.entries(lock.packages || {})) {
  if (!location.startsWith('node_modules/')) continue;
  let info;
  try {
    info = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const name = info.name || location.split('node_modules/').at(-1),
    directory = name.replaceAll('/', '__') + '@' + info.version;
  const files = (await fs.readdir(location)).filter((name) =>
    /^(licen[cs]e|copying|notice|ofl)([._-]|$)/i.test(name),
  );
  const copied = [];
  for (const file of files) {
    const source = path.join(location, file);
    if (!(await fs.stat(source)).isFile()) continue;
    await fs.mkdir(path.join(output, directory), { recursive: true });
    await fs.copyFile(source, path.join(output, directory, file));
    copied.push(directory + '/' + file);
  }
  records.push({
    name,
    version: info.version,
    license: info.license || entry.license || 'See upstream package',
    files: copied,
  });
}
await fs.writeFile(path.join(output, 'index.json'), JSON.stringify(records, null, 2) + '\n');
await fs.writeFile(
  path.join(output, 'README.txt'),
  'Dependency license texts and package metadata for this Folio build.\nThis directory includes the build dependency tree so licenses for bundled frontend code remain available.\nFolio licensing and distribution status are described in the project documentation.\n',
);
console.log('Collected dependency notices for ' + records.length + ' installed packages.');
