/**
 * NFC Bridge — NCI protocol driver for NXP PN7150 via MIKROE-2540 USB dongle.
 *
 * Communicates with the PN7150 NFC controller via NCI (NFC Controller Interface)
 * protocol over USB HID using the LPCUSBSIO I2C bridge on the LPC11U24.
 *
 * Architecture:
 *   NfcBridge → LPCUSBSIO (HID) → LPC11U24 → I2C → PN7150 (NCI)
 *
 * The MIKROE-2540 is NOT a serial/COM device — it's USB HID.
 *   VID: 0x1FC9 (NXP), PID: 0x0088 (LPCUSBSIO)
 *   PN7150 I2C slave address: 0x28
 *
 * Tag format:
 *   NTAG216 (888 bytes user memory). Stores NDEF payload:
 *     - member-id: NDEF Text Record (~120 bytes)
 *     - credential-attestation: NDEF External Type Record (~578 bytes)
 *
 * Usage:
 *   const bridge = new NfcBridge();
 *   await bridge.connect();       // Auto-detects HID device
 *   bridge.on('tag:read', (data) => console.log('WalletId:', data.walletId));
 */
import { EventEmitter } from 'events';
import HID from 'node-hid';

// ─── LPCUSBSIO Constants ────────────────────────────────────

const LPCUSBSIO_VID = 0x1FC9;
const LPCUSBSIO_PID = 0x0088;

// I2C request types
const HID_I2C_REQ_INIT_PORT    = 0x01;
const HID_I2C_REQ_DEVICE_WRITE = 0x03;
const HID_I2C_REQ_DEVICE_READ  = 0x04;

// I2C transfer options
const I2C_TRANSFER_START_BIT  = 0x01;
const I2C_TRANSFER_STOP_BIT   = 0x02;
const I2C_TRANSFER_NACK_LAST  = 0x08;

// PN7150 I2C slave address (7-bit)
const PN7150_I2C_ADDR = 0x28;

// ─── NCI Constants ──────────────────────────────────────────

// Message Types (MT) — upper 3 bits of byte 0
const NCI_MT_CMD  = 0x20;
const NCI_MT_NTF  = 0x60;
const NCI_MT_DATA = 0x00;

// Group IDs (GID) — lower 4 bits of byte 0
const NCI_GID_CORE = 0x00;
const NCI_GID_RF   = 0x01;

// Opcode Identifiers (OID)
const NCI_OID_CORE_RESET       = 0x00;
const NCI_OID_CORE_INIT        = 0x01;
const NCI_OID_RF_DISCOVER_MAP  = 0x00;
const NCI_OID_RF_DISCOVER      = 0x03;
const NCI_OID_RF_DEACTIVATE    = 0x06;

// RF Interface Activated Notification
const NCI_RF_INTF_ACTIVATED_NTF_OID = 0x05;

// Deactivation types
const NCI_DEACTIVATE_IDLE      = 0x00;
const NCI_DEACTIVATE_DISCOVERY = 0x03;

// T2T commands (sent via NCI Data Message)
const T2T_CMD_READ  = 0x30;
const T2T_CMD_WRITE = 0xA2;

// NDEF TLV
const NDEF_TLV_TYPE       = 0x03;
const NDEF_TLV_TERMINATOR = 0xFE;

// NCI status codes
const NCI_STATUS_OK = 0x00;

// ─── Types ──────────────────────────────────────────────────

export type NfcBridgeState = 'disconnected' | 'initializing' | 'polling' | 'tag_present' | 'writing' | 'error';

export interface NfcBridgeStatus {
  state: NfcBridgeState;
  devicePath: string | null;
  tagUid: string | null;
  pendingWrite: string | null;
  error: string | null;
}

export interface NfcTagEvent {
  type: 'tag:detected' | 'tag:read' | 'tag:written' | 'tag:removed' | 'tag:error';
  uid?: string;
  walletId?: string;
  attestation?: Record<string, unknown>;
  timestamp: number;
  error?: string;
}

/** Union type for NDEF payloads — legacy member-id or credential attestation */
export type NdefPayload =
  | { type: 'member-id'; walletId: string }
  | { type: 'credential-attestation'; attestation: Record<string, unknown> };

/** Result of parsing an NDEF message from a tag */
export type ParsedNdefPayload =
  | { type: 'member-id'; walletId: string }
  | { type: 'credential-attestation'; attestation: Record<string, unknown> }
  | null;

interface PendingWrite {
  payload: NdefPayload;
  resolve: () => void;
  reject: (err: Error) => void;
}

// ─── NDEF Helpers ───────────────────────────────────────────

/**
 * Build an NDEF message for an NFC tag payload.
 *
 * Supports two formats:
 *   - member-id: NDEF Text Record (TNF 0x01, SR=1, ~120 bytes) — legacy walletId-only
 *   - credential-attestation: NDEF External Type Record (TNF 0x04, SR=0, ~500 bytes)
 */
function buildNdefMessage(payload: NdefPayload): Buffer {
  if (payload.type === 'member-id') {
    return _buildMemberIdNdef(payload.walletId);
  } else {
    return _buildAttestationNdef(payload.attestation);
  }
}

/** Build NDEF Text Record for legacy walletId-only payload (~120 bytes, Short Record) */
function _buildMemberIdNdef(walletId: string): Buffer {
  const json = JSON.stringify({
    v: 1,
    t: 'member-id',
    w: walletId,
    ts: Math.floor(Date.now() / 1000),
  });

  const payloadBytes = Buffer.from(json, 'utf8');
  const langCode = Buffer.from('en', 'ascii');
  const statusByte = 0x02; // UTF-8, language code length = 2
  const textPayload = Buffer.concat([
    Buffer.from([statusByte]),
    langCode,
    payloadBytes,
  ]);

  // Flags: MB=1, ME=1, CF=0, SR=1, IL=0, TNF=0x01 (Well-Known)
  const flags = 0xD1;
  const typeField = Buffer.from('T', 'ascii');
  const payloadLen = textPayload.length;

  if (payloadLen > 255) {
    throw new Error(`Member-ID payload too large: ${payloadLen} bytes (max 255)`);
  }

  return Buffer.concat([
    Buffer.from([flags, typeField.length, payloadLen]),
    typeField,
    textPayload,
  ]);
}

/**
 * Build NDEF External Type Record for credential attestation (~500 bytes).
 * Uses Long Record format (SR=0) since payload exceeds 255 bytes.
 * Type: "zktrident.care:attestation"
 */
function _buildAttestationNdef(attestation: Record<string, unknown>): Buffer {
  const json = JSON.stringify(attestation);
  const payloadBytes = Buffer.from(json, 'utf8');
  const typeField = Buffer.from('zktrident.care:attestation', 'ascii');

  const payloadLen = payloadBytes.length;
  if (payloadLen > 800) {
    throw new Error(`Attestation payload too large: ${payloadLen} bytes (max 800 for NTAG216)`);
  }

  if (payloadLen <= 255) {
    // Short Record (SR=1): 1-byte payload length
    // Flags: MB=1, ME=1, CF=0, SR=1, IL=0, TNF=0x04 (External)
    const flags = 0xD4;
    return Buffer.concat([
      Buffer.from([flags, typeField.length, payloadLen]),
      typeField,
      payloadBytes,
    ]);
  } else {
    // Long Record (SR=0): 4-byte payload length
    // Flags: MB=1, ME=1, CF=0, SR=0, IL=0, TNF=0x04 (External)
    const flags = 0xC4;
    return Buffer.concat([
      Buffer.from([
        flags,
        typeField.length,
        (payloadLen >> 24) & 0xFF,
        (payloadLen >> 16) & 0xFF,
        (payloadLen >> 8) & 0xFF,
        payloadLen & 0xFF,
      ]),
      typeField,
      payloadBytes,
    ]);
  }
}

/**
 * Wrap an NDEF message in TLV format for writing to T2T (NTAG).
 * Returns bytes: [03 LEN <ndef_message> FE]
 */
function wrapNdefTlv(ndefMessage: Buffer): Buffer {
  const len = ndefMessage.length;
  if (len < 255) {
    return Buffer.concat([
      Buffer.from([NDEF_TLV_TYPE, len]),
      ndefMessage,
      Buffer.from([NDEF_TLV_TERMINATOR]),
    ]);
  } else {
    return Buffer.concat([
      Buffer.from([NDEF_TLV_TYPE, 0xFF, (len >> 8) & 0xFF, len & 0xFF]),
      ndefMessage,
      Buffer.from([NDEF_TLV_TERMINATOR]),
    ]);
  }
}

/**
 * Parse NDEF TLV from raw tag memory bytes (starting from page 4).
 */
function parseNdefTlv(data: Buffer): Buffer | null {
  let offset = 0;
  while (offset < data.length) {
    const type = data[offset];
    if (type === NDEF_TLV_TERMINATOR) break;
    if (type === 0x00) { // NULL TLV (padding)
      offset++;
      continue;
    }

    offset++; // skip type byte
    if (offset >= data.length) break;

    let length: number;
    if (data[offset] === 0xFF) {
      if (offset + 2 >= data.length) break;
      length = (data[offset + 1] << 8) | data[offset + 2];
      offset += 3;
    } else {
      length = data[offset];
      offset++;
    }

    if (type === NDEF_TLV_TYPE) {
      if (offset + length > data.length) break;
      return data.subarray(offset, offset + length);
    }

    offset += length;
  }
  return null;
}

/**
 * Parse an NDEF record and extract the payload.
 *
 * Returns a discriminated union:
 *   - { type: 'member-id', walletId } — legacy NDEF Text Record (v:1)
 *   - { type: 'credential-attestation', attestation } — NDEF External Type (v:2)
 *   - null — unrecognized format
 */
function parseNdefPayload(ndefMessage: Buffer): ParsedNdefPayload {
  if (ndefMessage.length < 5) return null;

  const flags = ndefMessage[0];
  const tnf = flags & 0x07;
  const typeLen = ndefMessage[1];
  const sr = (flags >> 4) & 0x01;

  let payloadLen: number;
  let headerLen: number;
  if (sr) {
    payloadLen = ndefMessage[2];
    headerLen = 3 + typeLen;
  } else {
    payloadLen = (ndefMessage[2] << 24) | (ndefMessage[3] << 16) | (ndefMessage[4] << 8) | ndefMessage[5];
    headerLen = 6 + typeLen;
  }

  if (headerLen + payloadLen > ndefMessage.length) return null;

  const typeField = ndefMessage.subarray(sr ? 3 : 6, sr ? 3 + typeLen : 6 + typeLen).toString('ascii');
  const payload = ndefMessage.subarray(headerLen, headerLen + payloadLen);

  if (tnf === 0x01 && typeField === 'T') {
    const statusByte = payload[0];
    const langLen = statusByte & 0x3F;
    const textStart = 1 + langLen;
    if (textStart >= payload.length) return null;
    const text = payload.subarray(textStart).toString('utf8');
    try {
      const parsed = JSON.parse(text);
      if (parsed.v === 1 && parsed.t === 'member-id' && typeof parsed.w === 'string') {
        return { type: 'member-id', walletId: parsed.w };
      }
    } catch { /* not valid JSON */ }
  } else if (tnf === 0x04) {
    const text = payload.toString('utf8');
    try {
      const parsed = JSON.parse(text);
      if (parsed.v === 2 && parsed.t === 'credential-attestation' && typeof parsed.w === 'string') {
        return { type: 'credential-attestation', attestation: parsed };
      }
      if (parsed.v === 1 && parsed.t === 'member-id' && typeof parsed.w === 'string') {
        return { type: 'member-id', walletId: parsed.w };
      }
    } catch { /* not valid JSON */ }
  }

  return null;
}

// ─── NCI Helpers ────────────────────────────────────────────

/** Build an NCI command frame: [MT|GID, OID, LEN, ...payload] */
function nciCmd(gid: number, oid: number, payload: number[] = []): number[] {
  return [NCI_MT_CMD | gid, oid, payload.length, ...payload];
}

/** Build an NCI data message: [0x00, connId, LEN, ...data] */
function nciData(connId: number, data: number[]): number[] {
  return [NCI_MT_DATA, connId, data.length, ...data];
}

/** Extract the message type from byte 0 */
function nciMsgType(byte0: number): number { return byte0 & 0xE0; }

// ─── LPCUSBSIO I2C Transport ───────────────────────────────

class LpcUsbSioTransport {
  private device: HID.HID | null = null;
  readonly devicePath: string;

  constructor(devicePath: string) {
    this.devicePath = devicePath;
  }

  /** Open the HID device, send warmup write, and initialize I2C at 400kHz. */
  open(): void {
    this.device = new HID.HID(this.devicePath);

    // Warmup — first write after open always gets no response from this firmware.
    // Send a dummy packet and discard the (missing) response.
    const warmup = new Array(65).fill(0);
    warmup[0] = 0x00; // HID Report ID
    this.device.write(warmup);
    try { this.device.readTimeout(500); } catch { /* expected: no response */ }

    this._i2cInit();
  }

  /** Close the HID device. */
  close(): void {
    if (this.device) {
      try { this.device.close(); } catch { /* ignore */ }
      this.device = null;
    }
  }

  get isOpen(): boolean {
    return this.device !== null;
  }

  /** Send an NCI command to the PN7150 via I2C write. */
  nciWrite(nciPacket: number[]): void {
    this._i2cWrite(PN7150_I2C_ADDR, nciPacket);
  }

  /**
   * Read an NCI response/notification from the PN7150 via I2C read.
   * Returns the raw NCI frame bytes, or null if no data available.
   */
  nciRead(maxLen = 32): Buffer | null {
    try {
      const data = this._i2cRead(PN7150_I2C_ADDR, maxLen);
      // Check if we got valid NCI data (at least 3 bytes with non-zero content)
      if (data.length >= 3 && (data[0] !== 0x00 || data[1] !== 0x00)) {
        // Extract actual NCI frame length
        const frameLen = 3 + data[2]; // header(3) + payload length
        return data.subarray(0, Math.min(frameLen, data.length));
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Send NCI command and wait for the response.
   * Polls I2C reads until a response is received or timeout.
   */
  nciCommandSync(nciPacket: number[], timeoutMs = 2000, readLen = 32): Buffer {
    this.nciWrite(nciPacket);
    return this._pollForNciResponse(timeoutMs, readLen);
  }

  /**
   * Poll for an NCI notification (async events like tag detection).
   * Returns the notification frame, or null if timeout.
   */
  nciPollNotification(timeoutMs = 100, readLen = 64): Buffer | null {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = this.nciRead(readLen);
      if (frame) return frame;
      // Brief pause between polls
      this._busyWait(5);
    }
    return null;
  }

  // ─── Private I2C operations ─────────────────────────────

  private _i2cInit(): void {
    // Clock: 400kHz = 0x61A80 → LE: [0x80, 0x1A, 0x06, 0x00]
    const clockRateLE = [0x80, 0x1A, 0x06, 0x00];
    const optionsLE = [0x00, 0x00, 0x00, 0x00];
    const resp = this._sendHidCommand(HID_I2C_REQ_INIT_PORT, [...clockRateLE, ...optionsLE]);
    const parsed = this._parseHidResponse(resp);
    if (parsed.status !== 0x00) {
      throw new Error(`I2C INIT_PORT failed: status 0x${parsed.status.toString(16)}`);
    }
  }

  private _i2cWrite(slaveAddr: number, data: number[]): void {
    const options = I2C_TRANSFER_START_BIT | I2C_TRANSFER_STOP_BIT;
    const params = [
      data.length & 0xFF,
      (data.length >> 8) & 0xFF,
      options,
      slaveAddr,
      ...data,
    ];
    const resp = this._sendHidCommand(HID_I2C_REQ_DEVICE_WRITE, params);
    const parsed = this._parseHidResponse(resp);
    if (parsed.status !== 0x00) {
      throw new Error(`I2C write failed: status 0x${parsed.status.toString(16)}`);
    }
  }

  private _i2cRead(slaveAddr: number, readLen: number): Buffer {
    const options = I2C_TRANSFER_START_BIT | I2C_TRANSFER_STOP_BIT | I2C_TRANSFER_NACK_LAST;
    const params = [
      readLen & 0xFF,
      (readLen >> 8) & 0xFF,
      options,
      slaveAddr,
    ];
    const resp = this._sendHidCommand(HID_I2C_REQ_DEVICE_READ, params);
    const parsed = this._parseHidResponse(resp);
    if (parsed.status !== 0x00) {
      throw new Error(`I2C read failed: status 0x${parsed.status.toString(16)}`);
    }
    return parsed.data;
  }

  private _sendHidCommand(req: number, data: number[]): Buffer {
    if (!this.device) throw new Error('Device not open');

    const length = 3 + data.length; // bytes AFTER length field: transId(1) + sesId(1) + req(1) + data
    const report = new Array(65).fill(0);
    report[0] = 0x00; // HID Report ID (required on Windows)
    report[1] = length;
    report[2] = 0x00; // transId — MUST be 0x00 (firmware rejects non-zero)
    report[3] = 0x00; // Session ID
    report[4] = req;
    for (let i = 0; i < data.length; i++) {
      report[5 + i] = data[i];
    }

    this.device.write(report);

    const response = this.device.readTimeout(2000);
    if (!response || response.length === 0) {
      throw new Error('HID read timeout');
    }
    return Buffer.from(response);
  }

  private _parseHidResponse(buf: Buffer): { status: number; data: Buffer } {
    // Response: [length, transId, sesId, status, ...data]
    // length = bytes AFTER the length field (not including itself)
    // So total meaningful bytes = 1 (length) + length
    const length = buf[0];
    const status = buf[3];
    const data = buf.subarray(4, 1 + length); // 1 for length byte + length payload bytes
    return { status, data };
  }

  private _pollForNciResponse(timeoutMs: number, readLen: number): Buffer {
    const deadline = Date.now() + timeoutMs;
    // Initial delay for PN7150 to process
    this._busyWait(10);

    while (Date.now() < deadline) {
      const frame = this.nciRead(readLen);
      if (frame) return frame;
      this._busyWait(5);
    }
    throw new Error('NCI response timeout');
  }

  private _busyWait(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

// ─── NfcBridge Class ────────────────────────────────────────

export class NfcBridge extends EventEmitter {
  private transport: LpcUsbSioTransport | null = null;
  private state: NfcBridgeState = 'disconnected';
  private tagUid: string | null = null;
  private pendingWrite: PendingWrite | null = null;
  private lastError: string | null = null;
  private connId: number = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────

  /**
   * Connect to the PN7150 NFC reader.
   * Auto-detects the MIKROE-2540 USB HID device (VID 0x1FC9, PID 0x0088).
   */
  async connect(): Promise<void> {
    if (this.transport) {
      await this.disconnect();
    }

    // Find the LPCUSBSIO HID device
    const allDevices = HID.devices();
    const nfcDevices = allDevices.filter(
      d => d.vendorId === LPCUSBSIO_VID && d.productId === LPCUSBSIO_PID
    );

    if (nfcDevices.length === 0) {
      this._setState('disconnected');
      throw new Error(
        'No MIKROE-2540 NFC reader found. ' +
        `Looking for USB HID VID:0x${LPCUSBSIO_VID.toString(16).toUpperCase()} PID:0x${LPCUSBSIO_PID.toString(16).toUpperCase()}. ` +
        'Check that the dongle is plugged in and appears in Device Manager → Human Interface Devices.'
      );
    }

    const devicePath = nfcDevices[0].path;
    if (!devicePath) {
      throw new Error('HID device found but has no path');
    }

    this._setState('initializing');

    try {
      // Open HID + I2C init
      this.transport = new LpcUsbSioTransport(devicePath);
      this.transport.open();

      // NCI initialization
      await this._nciInit();

      console.log(`  [NFC] Connected to PN7150 via HID (${devicePath})`);
      this._startPollingLoop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.transport) {
        this.transport.close();
        this.transport = null;
      }
      this._setState('disconnected');
      throw new Error(`NFC init failed: ${msg}`);
    }
  }

  async disconnect(): Promise<void> {
    this._clearPollTimer();
    if (this.transport && this.transport.isOpen) {
      try {
        this._stopPolling();
      } catch { /* ignore */ }
      this.transport.close();
    }
    this.transport = null;
    this._setState('disconnected');
    this.tagUid = null;
  }

  getStatus(): NfcBridgeStatus {
    return {
      state: this.state,
      devicePath: this.transport?.devicePath ?? null,
      tagUid: this.tagUid,
      pendingWrite: this.pendingWrite
        ? (this.pendingWrite.payload.type === 'member-id'
          ? this.pendingWrite.payload.walletId
          : (this.pendingWrite.payload.attestation as any).w ?? 'attestation')
        : null,
      error: this.lastError,
    };
  }

  /**
   * Queue a payload to be written to the next tag placed on the reader.
   * Accepts either a member-id (walletId only) or credential-attestation payload.
   */
  queueWrite(payload: NdefPayload): Promise<void> {
    if (this.pendingWrite) {
      this.pendingWrite.reject(new Error('Cancelled — new write queued'));
    }

    return new Promise((resolve, reject) => {
      this.pendingWrite = { payload, resolve, reject };
      this.emit('status', this.getStatus());

      if (this.state === 'tag_present') {
        this._handleTagForWrite();
      }
    });
  }

  cancelWrite(): void {
    if (this.pendingWrite) {
      this.pendingWrite.reject(new Error('Write cancelled'));
      this.pendingWrite = null;
      this.emit('status', this.getStatus());
    }
  }

  // ─── Private: NCI Protocol ──────────────────────────────

  /** Initialize the PN7150: CORE_RESET → CORE_INIT → RF_DISCOVER_MAP */
  private async _nciInit(): Promise<void> {
    if (!this.transport) throw new Error('Transport not open');

    // 1. CORE_RESET (keep config)
    const resetRsp = this.transport.nciCommandSync(
      nciCmd(NCI_GID_CORE, NCI_OID_CORE_RESET, [0x01])
    );
    if (resetRsp.length < 4 || resetRsp[3] !== NCI_STATUS_OK) {
      throw new Error(`CORE_RESET failed: status ${resetRsp[3]?.toString(16)}`);
    }

    // Wait for PN7150 to reset
    await this._delay(50);

    // 2. CORE_INIT
    const initRsp = this.transport.nciCommandSync(
      nciCmd(NCI_GID_CORE, NCI_OID_CORE_INIT, []),
      3000, 64
    );
    if (initRsp.length < 4 || initRsp[3] !== NCI_STATUS_OK) {
      throw new Error(`CORE_INIT failed: status ${initRsp[3]?.toString(16)}`);
    }

    // 3. RF_DISCOVER_MAP — map NFC-A Poll to Frame RF Interface
    const mapRsp = this.transport.nciCommandSync(
      nciCmd(NCI_GID_RF, NCI_OID_RF_DISCOVER_MAP, [
        0x01,  // 1 mapping entry
        0x00,  // RF Technology: NFC-A
        0x01,  // Mode: Poll
        0x02,  // RF Interface: Frame (for T2T)
      ])
    );
    if (mapRsp.length < 4 || mapRsp[3] !== NCI_STATUS_OK) {
      throw new Error(`RF_DISCOVER_MAP failed: status ${mapRsp[3]?.toString(16)}`);
    }
  }

  /** Start RF discovery (polling for tags). */
  private _startPollingNci(): void {
    if (!this.transport) return;

    const discoverRsp = this.transport.nciCommandSync(
      nciCmd(NCI_GID_RF, NCI_OID_RF_DISCOVER, [
        0x01,  // 1 config
        0x00,  // RF Technology: NFC-A
        0x01,  // Discovery frequency: every cycle
      ])
    );
    if (discoverRsp.length < 4 || discoverRsp[3] !== NCI_STATUS_OK) {
      throw new Error(`RF_DISCOVER failed: status ${discoverRsp[3]?.toString(16)}`);
    }
    this._setState('polling');
  }

  /** Stop RF discovery. */
  private _stopPolling(): void {
    if (!this.transport) return;
    try {
      this.transport.nciCommandSync(
        nciCmd(NCI_GID_RF, NCI_OID_RF_DEACTIVATE, [NCI_DEACTIVATE_IDLE]),
        1000
      );
    } catch { /* ignore — may already be idle */ }
  }

  // ─── Private: Tag Handling ──────────────────────────────

  /** Handle RF_INTF_ACTIVATED_NTF — a tag has entered the field. */
  private async _handleTagActivated(frame: Buffer): Promise<void> {
    const payload = frame.subarray(3);
    let uid = 'unknown';

    // Extract connection ID (byte 0 of payload)
    if (payload.length > 0) {
      this.connId = payload[0];
    }

    // Extract UID from NFC-A activation parameters
    if (payload.length >= 9) {
      const techParamsLen = payload[7];
      if (techParamsLen >= 4 && payload.length >= 8 + techParamsLen) {
        const nfcid1Len = payload[10];
        if (nfcid1Len > 0 && payload.length >= 11 + nfcid1Len) {
          const uidBytes = payload.subarray(11, 11 + nfcid1Len);
          uid = Array.from(uidBytes).map(b => b.toString(16).padStart(2, '0')).join(':');
        }
      }
    }

    this.tagUid = uid;
    this._setState('tag_present');
    this.emit('tag:detected', { type: 'tag:detected', uid, timestamp: Date.now() } as NfcTagEvent);

    if (this.pendingWrite) {
      await this._handleTagForWrite();
    } else {
      await this._handleTagForRead();
    }
  }

  /** Handle tag deactivation notification. */
  private _handleTagDeactivated(): void {
    if (this.tagUid) {
      this.emit('tag:removed', { type: 'tag:removed', uid: this.tagUid, timestamp: Date.now() } as NfcTagEvent);
    }
    this.tagUid = null;
    this.connId = 0;
    this._setState('polling');
  }

  /** Read NDEF data from the currently activated tag. */
  private async _handleTagForRead(): Promise<void> {
    try {
      const parsed = this._readNdef();
      if (parsed) {
        if (parsed.type === 'credential-attestation') {
          this.emit('tag:read', {
            type: 'tag:read',
            uid: this.tagUid,
            walletId: (parsed.attestation as any).w ?? null,
            attestation: parsed.attestation,
            timestamp: Date.now(),
          } as NfcTagEvent);
        } else {
          this.emit('tag:read', {
            type: 'tag:read',
            uid: this.tagUid,
            walletId: parsed.walletId,
            timestamp: Date.now(),
          } as NfcTagEvent);
        }
      } else {
        this.emit('tag:read', {
          type: 'tag:read',
          uid: this.tagUid,
          walletId: null,
          timestamp: Date.now(),
          error: 'No valid NDEF payload found on tag',
        } as NfcTagEvent);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('tag:error', { type: 'tag:error', error: `Read error: ${message}`, timestamp: Date.now() } as NfcTagEvent);
    }

    this._deactivateAndResume();
  }

  /** Write NDEF data to the currently activated tag. */
  private async _handleTagForWrite(): Promise<void> {
    if (!this.pendingWrite) return;

    const { payload, resolve, reject } = this.pendingWrite;
    this.pendingWrite = null;
    this._setState('writing');

    const walletId = payload.type === 'member-id'
      ? payload.walletId
      : (payload.attestation as any).w ?? null;

    try {
      this._writeNdef(payload);
      const evt: NfcTagEvent = {
        type: 'tag:written',
        uid: this.tagUid,
        walletId,
        timestamp: Date.now(),
      };
      if (payload.type === 'credential-attestation') {
        evt.attestation = payload.attestation;
      }
      this.emit('tag:written', evt);
      resolve();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('tag:error', { type: 'tag:error', error: `Write error: ${message}`, timestamp: Date.now() } as NfcTagEvent);
      reject(new Error(message));
    }

    this._deactivateAndResume();
  }

  // ─── Private: T2T Read/Write ────────────────────────────

  /** Write a single T2T page (4 bytes). */
  private _writePage(page: number, data: Buffer): void {
    if (!this.transport) throw new Error('Transport not open');
    if (data.length !== 4) throw new Error('T2T WRITE requires exactly 4 bytes');

    // Send T2T WRITE via NCI Data Message and wait for ACK
    const rsp = this._sendNciAndRead(
      nciData(this.connId, [T2T_CMD_WRITE, page, data[0], data[1], data[2], data[3]])
    );

    // Check for ACK (0x0A) in the response
    if (rsp.length >= 4 && rsp[3] !== 0x0A) {
      throw new Error(`T2T WRITE NACK for page ${page}: ${rsp[3]?.toString(16)}`);
    }

    // Delay for NTAG write (~5ms per write)
    const end = Date.now() + 10;
    while (Date.now() < end) { /* spin */ }
  }

  /** Send NCI packet and poll for response. */
  private _sendNciAndRead(nciPacket: number[], timeoutMs = 2000, readLen = 32): Buffer {
    if (!this.transport) throw new Error('Transport not open');

    this.transport.nciWrite(nciPacket);

    // Poll for response
    const deadline = Date.now() + timeoutMs;
    const end10 = Date.now() + 10;
    while (Date.now() < end10) { /* initial delay */ }

    while (Date.now() < deadline) {
      const frame = this.transport.nciRead(readLen);
      if (frame) return frame;
      const end5 = Date.now() + 5;
      while (Date.now() < end5) { /* spin */ }
    }
    throw new Error('NCI response timeout');
  }

  /** Read NDEF content from the tag. */
  private _readNdef(): ParsedNdefPayload {
    const chunks: Buffer[] = [];
    const maxPages = 225; // NTAG216 full user memory

    for (let page = 4; page < maxPages; page += 4) {
      try {
        const data = this._readPageDirect(page);
        chunks.push(data);

        if (data.includes(NDEF_TLV_TERMINATOR)) break;
      } catch {
        break;
      }
    }

    if (chunks.length === 0) return null;

    const tagData = Buffer.concat(chunks);
    const ndefMessage = parseNdefTlv(tagData);
    if (!ndefMessage) return null;

    return parseNdefPayload(ndefMessage);
  }

  /** Read a page using write-then-poll pattern. */
  private _readPageDirect(page: number): Buffer {
    const rsp = this._sendNciAndRead(
      nciData(this.connId, [T2T_CMD_READ, page])
    );
    if (rsp.length < 3) throw new Error(`Short read response for page ${page}`);
    const payloadLen = rsp[2];
    if (payloadLen < 1) throw new Error(`Empty read response for page ${page}`);
    return rsp.subarray(3, 3 + payloadLen);
  }

  /** Write NDEF content to the tag. */
  private _writeNdef(payload: NdefPayload): void {
    const ndefMessage = buildNdefMessage(payload);
    const tlvData = wrapNdefTlv(ndefMessage);

    if (tlvData.length > 888) {
      throw new Error(`Payload too large for NTAG216: ${tlvData.length} bytes (max 888)`);
    }

    for (let i = 0; i < tlvData.length; i += 4) {
      const page = 4 + Math.floor(i / 4);
      const pageData = Buffer.alloc(4, 0x00);
      tlvData.copy(pageData, 0, i, Math.min(i + 4, tlvData.length));
      this._writePage(page, pageData);
    }
  }

  // ─── Private: Polling Loop ──────────────────────────────

  /** Start the continuous polling loop. */
  private _startPollingLoop(): void {
    try {
      this._startPollingNci();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [NFC] Polling start failed: ${msg}`);
      this.lastError = msg;
      this._setState('error');
      return;
    }

    // Poll for NCI notifications (tag activated/deactivated)
    this.pollTimer = setInterval(() => {
      if (!this.transport || this.state === 'writing' || this.state === 'error') return;

      try {
        const frame = this.transport.nciPollNotification(50, 64);
        if (frame) {
          this._handleNciFrame(frame);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [NFC] Poll error: ${msg}`);
      }
    }, 100); // Poll every 100ms
  }

  /** Route an NCI frame to the appropriate handler. */
  private _handleNciFrame(frame: Buffer): void {
    const mt = nciMsgType(frame[0]);
    const gid = frame[0] & 0x0F;
    const oid = frame[1];

    if (mt === NCI_MT_NTF) {
      if (gid === NCI_GID_RF && oid === NCI_RF_INTF_ACTIVATED_NTF_OID) {
        this._handleTagActivated(frame);
      } else if (gid === NCI_GID_RF && oid === NCI_OID_RF_DEACTIVATE) {
        this._handleTagDeactivated();
      }
    }
  }

  /** Deactivate current tag and restart discovery. */
  private _deactivateAndResume(): void {
    if (!this.transport) return;

    try {
      this.transport.nciCommandSync(
        nciCmd(NCI_GID_RF, NCI_OID_RF_DEACTIVATE, [NCI_DEACTIVATE_DISCOVERY]),
        1000
      );
    } catch {
      try {
        this.transport.nciCommandSync(
          nciCmd(NCI_GID_RF, NCI_OID_RF_DEACTIVATE, [NCI_DEACTIVATE_IDLE]),
          1000
        );
        const end = Date.now() + 50;
        while (Date.now() < end) { /* spin */ }
        this._startPollingNci();
      } catch {
        this.lastError = 'Failed to resume polling';
        this._setState('error');
      }
    }
  }

  private _clearPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ─── Private: Utilities ─────────────────────────────────

  private _setState(state: NfcBridgeState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('status', this.getStatus());
    }
  }

  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
