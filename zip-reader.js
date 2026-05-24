'use strict';

/*
 * Minimal ZIP reader (no npm dependencies).
 *
 * Parses the End-of-Central-Directory record, walks the central directory,
 * and extracts each entry by reading its local file header and inflating
 * (or copying, if STORE) the raw bytes.
 *
 * Supports the common case (deflate / store, ZIP64 not needed). Throws on
 * encrypted or unsupported compression methods.
 *
 * Public API:
 *   readZipEntries(buffer, { filter }) -> Array<{ name, text, sizeUncompressed }>
 *
 * Only entries whose name matches `filter` (regex or function) are decoded.
 * Default filter accepts *.json files.
 */

const zlib = require('zlib');

const SIG_LFH = 0x04034b50; // local file header
const SIG_CFH = 0x02014b50; // central file header
const SIG_EOCD = 0x06054b50; // end of central directory

function findEOCD(buf) {
  // EOCD is at most 22 bytes + comment ≤ 65535 → search the last 65557 bytes.
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function readZipEntries(buf, opts = {}) {
  const filter = opts.filter || /\.json$/i;
  const matches =
    typeof filter === 'function'
      ? filter
      : (name) => filter.test(name);

  if (!Buffer.isBuffer(buf)) {
    throw new Error('readZipEntries: expected Buffer');
  }
  if (buf.length < 22) throw new Error('Tệp ZIP quá nhỏ');

  const eocdOff = findEOCD(buf);
  if (eocdOff < 0) throw new Error('Không tìm thấy EOCD — file có phải ZIP không?');

  const totalEntries = buf.readUInt16LE(eocdOff + 10);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOffset = buf.readUInt32LE(eocdOff + 16);

  if (cdOffset + cdSize > buf.length) {
    throw new Error('Central directory ngoài phạm vi buffer');
  }

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length) throw new Error('Central directory bị cắt cụt');
    if (buf.readUInt32LE(p) !== SIG_CFH) {
      throw new Error('Sai chữ ký central file header');
    }
    const compressionMethod = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const fileNameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lhOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + fileNameLen).toString('utf8');
    p += 46 + fileNameLen + extraLen + commentLen;

    // Skip directory entries.
    if (name.endsWith('/')) continue;
    if (!matches(name)) continue;

    if (lhOffset + 30 > buf.length) {
      throw new Error('Local header ngoài phạm vi buffer');
    }
    if (buf.readUInt32LE(lhOffset) !== SIG_LFH) {
      throw new Error(`Sai chữ ký local header tại entry "${name}"`);
    }
    const lhFlags = buf.readUInt16LE(lhOffset + 6);
    if (lhFlags & 0x0001) {
      throw new Error(`Entry "${name}" được mã hoá — không hỗ trợ`);
    }
    const lhFileNameLen = buf.readUInt16LE(lhOffset + 26);
    const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
    const dataStart = lhOffset + 30 + lhFileNameLen + lhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`Dữ liệu entry "${name}" bị cắt cụt`);
    }
    const compressed = buf.slice(dataStart, dataEnd);

    let raw;
    if (compressionMethod === 0) {
      raw = compressed;
    } else if (compressionMethod === 8) {
      raw = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(
        `Entry "${name}" dùng compression method ${compressionMethod} (không hỗ trợ — chỉ hỗ trợ STORE và DEFLATE)`
      );
    }

    if (raw.length !== uncompressedSize) {
      // Not strictly fatal, but worth noting.
    }

    out.push({
      name,
      text: raw.toString('utf8'),
      sizeUncompressed: raw.length,
    });
  }

  return out;
}

module.exports = { readZipEntries };
