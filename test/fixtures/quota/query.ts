import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const [file, ...args] = process.argv.slice(2);
if (process.env.XA_QUERY_MARKER) appendFileSync(process.env.XA_QUERY_MARKER, JSON.stringify({ file, args }) + '\n');
const sample = file === 'python3' ? 'cursor.txt' : file === 'grok' ? (args[0] === 'models' ? 'grok-models.txt' : 'grok.json') : file === 'cursor-agent' ? 'cursor-models.txt' : 'codex-models.json';
if (file === 'grok' && args[0] === 'agent') {
  let input = '';
  process.stdin.on('data', chunk => {
    input += chunk;
    if (input.includes('"id":2')) { process.stdout.write(readFileSync(join(import.meta.dirname, sample))); }
  });
} else {
  process.stdout.write(readFileSync(join(import.meta.dirname, sample)));
}
