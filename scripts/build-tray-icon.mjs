import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(path.join(root, 'assets', 'icon.svg'));
const png = await sharp(source).resize(32, 32, { fit: 'contain' }).png().toBuffer();
const output = path.join(root, 'dist', 'tray-icon.png');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, png);
