/** 合成夹具：从真实 source bundle 构造评审来源（全为虚构不透明字节，非真实模型/真实文档）。 */
import assert from 'node:assert/strict';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { buildFixture, load } from './source-bundle-fixture.ts';
import { registry } from './fixtures.ts';
import { baseSnapshot, makeInput } from './review-harness.ts';

/** 构造评审来源夹具；image=true 使用 image 类型块，否则使用 b000 原生段落块。 */
export async function makeReviewSourceFixture(image = false) {
  const built = buildFixture();
  try {
    const loaded = await load(built.dir, built.auth, { registry });
    assert(loaded.ok, 'source bundle load 失败: ' + JSON.stringify(loaded));

    const bundle = loaded.bundle;
    const document = bundle.document;
    const block = document.blocks.find((b) => (image ? b.type === 'image' : b.blockId === 'b000'));
    assert(block, image ? '未找到 image 类型块' : '未找到 b000 原生段落块');

    const snapshot = baseSnapshot();
    const input = makeInput(snapshot);

    input.projectId = document.projectId;
    input.scope.projectId = document.projectId;
    snapshot.projectId = document.projectId;
    input.documents = [document];
    input.scope.documentRefs = [
      { documentId: document.documentId, documentVersionId: document.documentVersionId },
    ];

    snapshot.coverage = {
      ...snapshot.coverage,
      documentsProcessed: [
        {
          documentId: document.documentId,
          documentVersionId: document.documentVersionId,
          blockIds: document.blocks.map((b) => b.blockId),
        },
      ],
      unsupported: [],
    };

    const evidence = snapshot.evidence[0];
    evidence.documentId = document.documentId;
    evidence.documentVersionId = document.documentVersionId;
    evidence.blockId = block.blockId;
    evidence.locator = block.location;
    evidence.excerpt = image ? '未核实的图片候选' : block.text;

    const claim = snapshot.claims[0];
    claim.value = { type: 'quantity', normalized: 12.5, unit: 'kg', raw: '12.5kg' };
    claim.qualifiers = { time: { year: 2024 }, basis: '报告年份2024' };
    claim.reviewStatus = 'pending';

    input.subject.contentHash = fingerprint(snapshot);

    const request = {
      documentId: document.documentId,
      documentVersionId: document.documentVersionId,
      blockId: block.blockId,
    };

    return { input, snapshot, bundle, request, cleanup: built.cleanup };
  } catch (err) {
    built.cleanup();
    throw err;
  }
}
