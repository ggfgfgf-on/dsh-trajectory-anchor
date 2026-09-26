#!/usr/bin/env node
/**
 * session-log-core.mjs — DSH 会话日志（session.jsonl.zstd）读取核心
 * 被 calibrate-lexicon.mjs / calibrate-from-scores.mjs / export-layer4.mjs 共用。
 * 零外部依赖（node:zlib 的 zstd 帧解码，Node ≥ 22）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const ZSTD_MAGIC = 0xfd2fb528

/** zstd 帧扫描（DSH 会话日志格式：连续 zstd 帧拼接，无外部长度表）。 */
export function scanZstdFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) break
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`)
    offset += 4
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解码整个会话日志为 JSONL 文本。 */
export function decodeSessionLog(path) {
  const buf = readFileSync(path)
  const { frames } = scanZstdFrames(buf)
  return frames.map(({ start, end }) => zstdDecompressSync(buf.subarray(start, end)).toString('utf8')).join('\n')
}

/** 递归列出目录下全部文件。 */
export function walk(dir, out) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 从一条会话日志记录中抽取推理/助手文本。 */
export function textFromRecord(o) {
  if (!o) return ''
  if (o.type === 'reasoning-chunks' && Array.isArray(o.data?.texts)) return o.data.texts.join(' ')
  if (o.type === 'assistant/message') {
    const c = o.data?.message?.content
    if (!Array.isArray(c)) return ''
    return c.filter((b) => b?.type === 'reasoning' || b?.type === 'text').map((b) => b.text ?? '').join(' ')
  }
  if (o.type === 'assistant/chunk') {
    const t = o.data?.chunk?.text
    return typeof t === 'string' ? t : ''
  }
  return ''
}

/** 从会话日志文件集合抽取全部推理文本块。 */
export function collectCorpus(path) {
  const chunks = []
  const files = statSync(path).isDirectory() ? walk(path, []) : [path]
  for (const f of files) {
    let text
    try { text = f.endsWith('.zstd') ? decodeSessionLog(f) : readFileSync(f, 'utf8') } catch { continue }
    if (f.endsWith('.jsonl') || f.endsWith('.zstd')) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        const t = textFromRecord(o)
        if (t) chunks.push(t)
      }
    } else if (/\.(txt|md|log)$/.test(f)) {
      if (text.trim()) chunks.push(text)
    }
  }
  return chunks
}
