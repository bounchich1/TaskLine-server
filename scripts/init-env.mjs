import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../.env', import.meta.url);
let text = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const password = randomBytes(24).toString('hex');
text = text
  .replaceAll('CHANGE_ME', password)
  .replace('GENERATE_64_HEX_CHARACTERS', randomBytes(32).toString('hex'))
  .replaceAll('GENERATE_RANDOM_SECRET', () => randomBytes(32).toString('hex'));
try {
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  console.log('Created ignored .env. Provider credentials are blank.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.log('.env already exists; preserved.');
  } else {
    throw error;
  }
}
