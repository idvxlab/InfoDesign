/**
 * 内容指纹：对业务成果做规范化 JSON 后计算 sha256。
 * 同一成果版本应得到稳定指纹，用于审查报告绑定与采纳前核对。
 */
import { createHash } from 'node:crypto';
import { canonicalize } from './validator.ts';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 计算业务成果指纹，返回 `sha256:<hex>` 形式。 */
export function fingerprint(value: unknown): string {
  return 'sha256:' + sha256Hex(canonicalize(value));
}

/** 计算原始文本（如合成资料）的指纹。 */
export function textFingerprint(text: string): string {
  return 'sha256:' + sha256Hex(text);
}