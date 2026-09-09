// Short, human-friendly order codes, e.g. "K7QX-9M2R".
// Mixed letters and digits from an unambiguous alphabet (no 0/O/1/I) so codes
// are easy to read out over the phone or in a Telegram message. Random — not
// sequential — so the code does not leak how many orders the shop has taken.

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const GROUP_SIZE = 4;

export function generateOrderCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < CODE_LENGTH; i++) {
    chars.push(ALPHABET[Math.floor(Math.random() * ALPHABET.length)]);
  }
  return chars
    .map((c, i) => (i > 0 && i % GROUP_SIZE === 0 ? `-${c}` : c))
    .join('');
}
