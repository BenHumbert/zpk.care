/**
 * NFC Diagnostic v7 — Scan commands 0x06+ and test GPIO VEN/DWL.
 *
 * The NXP NFC LPCUSBSIO library has GPIO_SetVENValue() and GPIO_SetDWLValue()
 * for controlling PN7150 power/reset pins. These likely use req codes 0x06-0x0F.
 * v6 crashed at cmd=0x05 before testing these.
 *
 * Also tests: sending commands with DATA (not just minimal packets),
 * since GPIO commands need parameters like [value] for pin high/low.
 *
 * Usage: npx tsx demo/nfc-test.ts
 */
import HID from 'node-hid';

const VID = 0x1FC9;
const PID = 0x0088;

function toHex(data: number[] | Buffer | Uint8Array, max = 64): string {
  return Array.from(data).slice(0, max).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function toAscii(data: Buffer | Uint8Array, start = 0, end?: number): string {
  return Array.from(data).slice(start, end).map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('');
}

function hidWrite(device: HID.HID, payload: number[]): void {
  const report = new Array(65).fill(0);
  report[0] = 0x00;
  for (let i = 0; i < payload.length; i++) report[1 + i] = payload[i];
  device.write(report);
}

function hidRead(device: HID.HID, timeoutMs = 1000): Buffer | null {
  const resp = device.readTimeout(timeoutMs);
  if (!resp || resp.length === 0) return null;
  return Buffer.from(resp);
}

/** Send LPCUSBSIO packet: [length, transId=0, sesId=0, req, ...data] */
function sendSio(device: HID.HID, req: number, data: number[] = [], timeoutMs = 1000): Buffer | null {
  const pkt = [3 + data.length, 0x00, 0x00, req, ...data];
  hidWrite(device, pkt);
  return hidRead(device, timeoutMs);
}

function respStr(resp: Buffer | null): string {
  if (!resp) return 'NO RESPONSE';
  const len = resp[0];
  return `[${toHex(resp, Math.min(len + 1, 16))}] resp=${resp[3]}`;
}

function isAlive(device: HID.HID): boolean {
  try {
    const r = sendSio(device, 0x00, [], 500);
    return r !== null;
  } catch { return false; }
}

function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   NFC Diagnostic v7 — GPIO VEN/DWL + Command 0x06+ Scan   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  const nfcDevices = HID.devices().filter(d => d.vendorId === VID && d.productId === PID);
  if (nfcDevices.length === 0) { console.log('  Device not found'); return; }
  console.log(`  Device: ${nfcDevices[0].product}`);

  const device = new HID.HID(nfcDevices[0].path!);

  try {
    // Warmup
    hidWrite(device, [0x00, 0x00, 0x00, 0x00]);
    hidRead(device, 500);
    console.log('  Warmup done');

    // Verify RESET works
    const rst = sendSio(device, 0x00);
    console.log(`  RESET: ${respStr(rst)}`);

    // ── Part 1: Test req=0x06 through 0x0F with different data ──
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Part 1: Commands 0x06-0x0F (possible GPIO VEN/DWL range)');
    console.log('  Testing each with data=[] and data=[0x00], data=[0x01]');
    console.log('═══════════════════════════════════════════════════════════');

    for (let req = 0x06; req <= 0x0F; req++) {
      // No data
      let r = sendSio(device, req, []);
      const noData = respStr(r);

      // data=[0x00]
      r = sendSio(device, req, [0x00]);
      const d0 = respStr(r);

      // data=[0x01]
      r = sendSio(device, req, [0x01]);
      const d1 = respStr(r);

      console.log(`  req=0x${req.toString(16).padStart(2,'0')}:`);
      console.log(`    no data: ${noData}`);
      console.log(`    data=00: ${d0}`);
      console.log(`    data=01: ${d1}`);

      // Check alive
      if (!isAlive(device)) {
        console.log(`    *** CRASHED at req=0x${req.toString(16)} ***`);
        return;
      }
    }

    // ── Part 2: Commands 0x10-0x20 with data ──────────────────
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Part 2: Commands 0x10-0x20 with data=[0x01] (GPIO range)');
    console.log('═══════════════════════════════════════════════════════════');

    for (let req = 0x10; req <= 0x20; req++) {
      const r = sendSio(device, req, [0x01]);
      if (!r) {
        console.log(`  req=0x${req.toString(16).padStart(2,'0')}: NO RESPONSE`);
        if (!isAlive(device)) {
          console.log(`    *** CRASHED ***`);
          return;
        }
      } else {
        const len = r[0];
        const isStandard = len === 5;
        if (!isStandard) {
          console.log(`  req=0x${req.toString(16).padStart(2,'0')}: *** DIFFERENT *** ${respStr(r)}`);
        }
      }
    }
    console.log('  (All standard responses omitted)');

    // ── Part 3: Try VEN pin toggle sequences ─────────────────
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Part 3: PN7150 VEN pin toggle (reset sequence)');
    console.log('  Try: VEN LOW (50ms) → VEN HIGH (50ms) → I2C INIT');
    console.log('═══════════════════════════════════════════════════════════');

    // Try each candidate req code for GPIO_SetVENValue
    const venCandidates = [0x06, 0x07, 0x08, 0x09, 0x0A];

    for (const venReq of venCandidates) {
      console.log(`\n  Trying req=0x${venReq.toString(16)} as GPIO_SetVENValue...`);

      // VEN LOW
      const r1 = sendSio(device, venReq, [0x00]);
      console.log(`    VEN LOW:  ${respStr(r1)}`);

      // Wait 50ms
      const d1 = Date.now(); while (Date.now() - d1 < 50) {}

      // VEN HIGH
      const r2 = sendSio(device, venReq, [0x01]);
      console.log(`    VEN HIGH: ${respStr(r2)}`);

      // Wait 10ms for PN7150 boot
      const d2 = Date.now(); while (Date.now() - d2 < 10) {}

      // Try I2C INIT
      const initR = sendSio(device, 0x01, [0x80, 0x1A, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00]);
      console.log(`    INIT_PORT: ${respStr(initR)}`);

      // Check if INIT succeeded (resp=0x00)
      if (initR && initR[3] === 0x00) {
        console.log(`    *** INIT_PORT SUCCEEDED with VEN on req=0x${venReq.toString(16)}! ***`);

        // Try I2C DEVICE_WRITE — NCI CORE_RESET
        console.log('    Trying I2C DEVICE_WRITE (NCI CORE_RESET to 0x28)...');
        const writeR = sendSio(device, 0x03, [
          0x04, 0x00,  // txLen LE
          0x03,         // START + STOP
          0x28,         // PN7150 addr
          0x20, 0x00, 0x01, 0x01,  // NCI CORE_RESET
        ], 3000);
        console.log(`    DEVICE_WRITE: ${respStr(writeR)}`);

        if (writeR) {
          // Try I2C read
          const readR = sendSio(device, 0x04, [
            0x20, 0x00,  // rxLen=32 LE
            0x0B,         // START+STOP+NACK_LAST
            0x28,
          ], 3000);
          console.log(`    DEVICE_READ: ${respStr(readR)}`);
        }

        break; // Success! Stop trying other VEN candidates
      }

      if (!isAlive(device)) {
        console.log('    *** CRASHED — stopping ***');
        return;
      }
    }

    // ── Part 4: Try INIT_PORT with different length formats ──
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Part 4: INIT_PORT with "total length" format (NXP spec)');
    console.log('  Official LPCUSBSIO says length = total including itself');
    console.log('═══════════════════════════════════════════════════════════');

    // Our format: length = 3 + data.length (bytes after length)
    // NXP format: length = 4 + data.length (total bytes including length)
    // For INIT_PORT with 8 bytes data:
    //   Ours:  [0x0B, 0x00, 0x00, 0x01, ...]  (length=11)
    //   NXP:   [0x0C, 0x00, 0x00, 0x01, ...]  (length=12)

    // Try NXP total-length format
    const initData = [0x80, 0x1A, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00];

    // NXP format: length = 4 + 8 = 12 = 0x0C
    const nxpPkt = [0x0C, 0x00, 0x00, 0x01, ...initData];
    console.log(`  NXP format:  TX: ${toHex(nxpPkt)}`);
    hidWrite(device, nxpPkt);
    const nxpResp = hidRead(device, 1000);
    console.log(`  NXP format:  RX: ${nxpResp ? respStr(nxpResp) : 'no response'}`);

    // Also try with length = 4 (total) for RESET
    const rstNxp = [0x04, 0x00, 0x00, 0x00]; // total-length format
    hidWrite(device, rstNxp);
    const rstNxpR = hidRead(device, 1000);
    console.log(`  RESET(len=4): ${rstNxpR ? respStr(rstNxpR) : 'no response'}`);

    // ── Part 5: Scan req 0x06+ safely ────────────────────────
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Part 5: Safe scan req=0x06 to 0x40 (no data)');
    console.log('  Looking for non-standard responses...');
    console.log('═══════════════════════════════════════════════════════════');

    let allStandard = true;
    for (let req = 0x06; req <= 0x40; req++) {
      const r = sendSio(device, req, [], 500);
      if (!r) {
        console.log(`  req=0x${req.toString(16).padStart(2,'0')}: NO RESPONSE ***`);
        allStandard = false;
        if (!isAlive(device)) {
          console.log('    *** CRASHED — stopping ***');
          break;
        }
      } else if (r[0] !== 5 || r[3] !== req) {
        console.log(`  req=0x${req.toString(16).padStart(2,'0')}: ${respStr(r)} *** DIFFERENT ***`);
        allStandard = false;
      }
    }
    if (allStandard) console.log('  All req=0x06-0x40 return standard echo (no GPIO VEN found)');

  } finally {
    device.close();
  }

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  Diagnostic v7 complete.');
  console.log('════════════════════════════════════════════════════════════');
}

try {
  main();
} catch (err) {
  console.error('Fatal:', err);
  process.exit(1);
}
