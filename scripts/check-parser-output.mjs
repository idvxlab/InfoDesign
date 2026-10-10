/** Offline inspection bundle validation against the unchanged authoritative contract. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemasFromDir } from '../packages/contracts/src/schema-registry.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = loadSchemasFromDir(resolve(root, 'packages/contracts/schemas'));
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function checkBundle(directory) {
  const base = realpathSync(directory);
  const read = (path) => {
    const target = realpathSync(resolve(base, path));
    assert.ok(target.startsWith(base + sep), 'artifact must stay inside output directory');
    return readFileSync(target);
  };
  const ir = JSON.parse(read('document-ir.json'));
  const manifest = JSON.parse(read('manifest.json'));
  const result = registry.validate('urn:tju-mas:contracts:document-ir', ir);
  assert.ok(result.valid, JSON.stringify(result.errors));
  assert.equal(ir.contentHash, digest(read('source.pdf')));
  assert.equal(manifest.source.sha256, ir.contentHash);
  assert.equal(manifest.source.page_count, manifest.pages.length);
  assert.equal(new Set(ir.blocks.map(b => b.blockId)).size, ir.blocks.length);
  const flatten = manifest.pages.flatMap(p => p.blocks);
  assert.equal(flatten.length, ir.blocks.length);
  for (const [index, block] of ir.blocks.entries()) {
    assert.equal(block.index, index);
    assert.equal(flatten[index].blockId, block.blockId);
    assert.deepEqual(flatten[index].location, block.location);
    const page = manifest.pages[block.location.page - 1];
    assert.ok(page);
    const checkBox = (location) => {
      assert.equal(location.page, page.page);
      const b = location.bbox;
      assert.ok(Object.values(b).every(Number.isFinite));
      assert.ok(b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0);
      assert.ok(b.x + b.width <= page.width + .00001 && b.y + b.height <= page.height + .00001);
    };
    checkBox(block.location);
    if (block.extensions.asset_path) assert.equal(digest(read(block.extensions.asset_path)), block.extensions.asset_hash);
    if (block.extensions.table_data_path) {
      const bytes = read(block.extensions.table_data_path);
      assert.equal(digest(bytes), block.extensions.table_data_hash);
      const table = JSON.parse(bytes);
      assert.equal(table.source_hash, ir.contentHash);
      assert.equal(table.block_id, block.blockId);
      assert.equal(table.status, 'candidate_not_reviewed');
      assert.deepEqual(table.location, block.location);
      for (const cell of table.cells) {
        checkBox(cell.location);
        assert.equal(cell.text, table.rows[cell.row][cell.column]);
        const b = cell.location.bbox, t = block.location.bbox;
        assert.ok(b.x >= t.x - .00001 && b.y >= t.y - .00001);
        assert.ok(b.x + b.width <= t.x + t.width + .00001 && b.y + b.height <= t.y + t.height + .00001);
      }
    }
  }
  for (const page of manifest.pages) {
    if (page.render) assert.equal(digest(read(page.render)), page.render_sha256);
    for (const [kind, count] of Object.entries(page.counts)) assert.equal(count, page.blocks.filter(b => b.type === kind).length);
  }
  for (const [kind, count] of Object.entries(manifest.counts)) assert.equal(count, ir.blocks.filter(b => b.type === kind).length);
  for (const item of ir.parseInfo.unsupported) assert.ok(ir.blocks.some(b => b.blockId === item.blockId));
  console.log(JSON.stringify({directory, valid: true, pages: manifest.pages.length, blocks: ir.blocks.length, counts: manifest.counts}));
}
assert.ok(process.argv.length > 2, 'usage: node scripts/check-parser-output.mjs OUTPUT_DIRECTORY [...]');
for (const directory of process.argv.slice(2)) checkBundle(directory);
