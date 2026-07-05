/**
 * Multipart form-data parser.
 *
 * Extracts text fields and file fields from a raw multipart buffer.
 * Used by voice clone/preview endpoints to parse the browser's FormData
 * without consuming the stream before engine resolution.
 */

/**
 * Parse multipart form-data buffer. Extracts text fields and file fields.
 * @param {Buffer} buffer — raw multipart body
 * @param {string} contentType — HTTP Content-Type header (contains boundary)
 * @returns {object} — { audio: Buffer, name?: string, voice_name?: string, ... }
 */
export function parseMultipart(buffer, contentType) {
  // Extract boundary from the HTTP Content-Type header (NOT from the body).
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) return { audio: buffer };

  const boundary = boundaryMatch[1].trim().replace(/^["']|["']$/g, '');
  const delim = Buffer.from('--' + boundary);
  const result = {};

  // Split on each occurrence of the boundary marker
  let pos = buffer.indexOf(delim);

  while (pos !== -1) {
    // Find next boundary
    const nextPos = buffer.indexOf(delim, pos + delim.length);
    const partEnd = nextPos !== -1 ? nextPos : buffer.length;

    // Skip boundary line itself (--boundary\r\n or --boundary\n)
    let partStart = pos + delim.length;
    if (buffer[partStart] === 13) partStart++;  // \r
    if (buffer[partStart] === 10) partStart++;  // \n

    if (partStart < partEnd && nextPos !== -1) { // skip the final boundary (--boundary--)
      const part = buffer.slice(partStart, partEnd);
      const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd !== -1) {
        const header = part.slice(0, headerEnd).toString('utf8');
        let body = part.slice(headerEnd + 4);

        // Trim trailing \r\n
        if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
          body = body.slice(0, -2);
        }

        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);

        if (nameMatch) {
          const name = nameMatch[1];
          result[name] = filenameMatch ? Buffer.from(body) : body.toString('utf8');
        }
      }
    }

    pos = nextPos;
  }

  // Fallback: if no audio key but large buffer, use raw bytes
  if (!result.audio && buffer.length > 1000) {
    result.audio = buffer;
  }

  return result;
}
