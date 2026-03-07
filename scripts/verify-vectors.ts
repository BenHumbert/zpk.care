import { Poseidon, Field } from 'o1js';
import { Encoding } from 'o1js';

function hashString(s: string) { return Poseidon.hash(Encoding.stringToFields(s)); }
function hashDate(d: string) { return Poseidon.hash([Field(BigInt(d))]); }

// With CORRECT domain tag = Field(0)
const walletId = Poseidon.hash([
  Field(0),  // DOMAIN_TAG_MEMBER
  hashString('CH-10001'),
  hashDate('19850315'),
  hashString('Alice'),
  hashString('Johnson'),
  hashString('test-enrollment-key-1234567890'),
]);
console.log('walletId (domain=0):', walletId.toString());

// Verify additional test vectors
console.log('Poseidon([1,2,3]):', Poseidon.hash([Field(1), Field(2), Field(3)]).toString());
console.log('Poseidon([123456789,987654321]):', Poseidon.hash([Field(123456789n), Field(987654321n)]).toString());
