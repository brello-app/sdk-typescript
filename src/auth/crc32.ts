/** CRC-32/ISO-HDLC, represented as eight lowercase hexadecimal characters. */
export function crc32(input: string): string {
  let crc = 0xffffffff;

  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index);

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }

  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
