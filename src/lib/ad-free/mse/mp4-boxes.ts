/**
 * Minimal ISO-BMFF box helpers for the MSE spike.
 * Enough to find ftyp+moov init length and rough mdat start.
 */

export type Mp4Box = {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  dataStart: number;
};

export function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

export function readBoxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  );
}

/** Parse top-level boxes in a buffer that starts at file offset `baseOffset`. */
export function parseTopLevelBoxes(bytes: Uint8Array, baseOffset = 0): Mp4Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Mp4Box[] = [];
  let offset = 0;

  while (offset + 8 <= bytes.byteLength) {
    let size = readU32(view, offset);
    const type = readBoxType(bytes, offset + 4);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > bytes.byteLength) {
        break;
      }
      // largesize — only lower 32 bits for spike (files <4GB typical)
      size = readU32(view, offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }

    if (size < headerSize) {
      break;
    }

    boxes.push({
      type,
      start: baseOffset + offset,
      size,
      headerSize,
      dataStart: baseOffset + offset + headerSize
    });

    // Incomplete box at end of buffer
    if (offset + size > bytes.byteLength) {
      break;
    }
    offset += size;
  }

  return boxes;
}

/**
 * Given the first N bytes of a file, return exclusive end offset of init
 * (ftyp + moov, and free/skip between them). Returns null if moov not fully present.
 */
export function findInitEnd(bytes: Uint8Array): number | null {
  const boxes = parseTopLevelBoxes(bytes, 0);
  let moov: Mp4Box | undefined;

  for (const box of boxes) {
    if (box.type === "moov") {
      moov = box;
    }
  }

  if (!moov) {
    // moov not found or incomplete in this buffer
    const partial = boxes.find(box => box.type === "moov" || box.start + 8 <= bytes.byteLength);
    if (!partial) {
      // Need more bytes — return how much we have as signal
      return null;
    }
    // Incomplete last box named? check if moov header only
    for (const box of boxes) {
      if (box.type === "moov" && box.start + box.size > bytes.byteLength) {
        return null;
      }
    }
    return null;
  }

  if (moov.start + moov.size > bytes.byteLength) {
    return null;
  }

  return moov.start + moov.size;
}

/** First mdat start offset if present in buffer; else null. */
export function findMdatStart(bytes: Uint8Array): number | null {
  const boxes = parseTopLevelBoxes(bytes, 0);
  const mdat = boxes.find(box => box.type === "mdat");
  return mdat ? mdat.start : null;
}

/**
 * Scan buffer for a plausible top-level `moof` header.
 * Returns offset relative to `bytes[0]` (not file offset).
 * Rejects absurd sizes to reduce false positives inside mdat.
 */
export function findMoofOffsetInBuffer(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxBox = 16 * 1024 * 1024;

  for (let offset = 0; offset + 8 <= bytes.byteLength; offset += 1) {
    if (readBoxType(bytes, offset + 4) !== "moof") {
      continue;
    }
    let size = readU32(view, offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) {
        continue;
      }
      size = readU32(view, offset + 12);
      headerSize = 16;
    }
    if (size < headerSize || size > maxBox) {
      continue;
    }
    // Prefer boxes that look aligned (common for fMP4 streams)
    return offset;
  }
  return null;
}

export function formatBytes(count: number): string {
  if (count < 1024) {
    return `${count} B`;
  }
  if (count < 1024 * 1024) {
    return `${(count / 1024).toFixed(1)} KB`;
  }
  return `${(count / (1024 * 1024)).toFixed(2)} MB`;
}
