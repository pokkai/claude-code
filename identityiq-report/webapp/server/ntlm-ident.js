'use strict';

/*
 * NTLM *identification* middleware.
 *
 * =========================== SECURITY WARNING ===========================
 * This middleware performs the NTLM handshake only to READ the username
 * and domain the client CLAIMS in its Type 3 message. It does NOT verify
 * the NTLM response against a domain controller and it has no keytab, so
 * the claimed identity is NOT authenticated and can be forged by anyone
 * who can reach this server (e.g. `curl --ntlm -u 'DOMAIN\anyone:x'`).
 *
 * This trade-off was explicitly chosen for this deployment: transparent
 * SSO-feel for domain-joined browsers without Kerberos/keytab setup, on a
 * network where reachability is already restricted. Do not expose this
 * app beyond that trusted network. Every claimed identity is logged with
 * the source IP so misuse is at least visible.
 * ========================================================================
 *
 * Protocol notes:
 * - Browsers only auto-negotiate NTLM for sites they trust (intranet zone
 *   / AuthServerAllowlist policy); others fail the handshake and are denied.
 * - We advertise "WWW-Authenticate: NTLM" (not "Negotiate") on purpose: a
 *   Kerberos blob inside Negotiate is encrypted with a service key we do
 *   not have, whereas the NTLM Type 3 message carries the claimed
 *   domain\user in plaintext fields.
 * - NTLM authenticates a TCP connection, not a request: once the handshake
 *   completes we remember the identity on the socket, as IIS does.
 */

const crypto = require('crypto');

const NTLM_SIGNATURE = 'NTLMSSP\0';

// Type 2 (challenge) flags: UNICODE (0x01) | NEGOTIATE_NTLM (0x200).
const TYPE2_FLAGS = 0x00000201;

function buildType2Challenge() {
  const buf = Buffer.alloc(40);
  buf.write(NTLM_SIGNATURE, 0, 'latin1');
  buf.writeUInt32LE(2, 8); // message type
  // TargetName security buffer: empty, pointing past the fixed part.
  buf.writeUInt16LE(0, 12);
  buf.writeUInt16LE(0, 14);
  buf.writeUInt32LE(40, 16);
  buf.writeUInt32LE(TYPE2_FLAGS, 20);
  // 8-byte server challenge. Random, but its value is irrelevant since the
  // response is never validated.
  crypto.randomBytes(8).copy(buf, 24);
  // 8 reserved/context bytes at 32 remain zero.
  return buf;
}

// A "security buffer" is length(2) + maxLength(2) + offset(4), all LE.
function readSecurityBuffer(msg, at) {
  if (msg.length < at + 8) return null;
  const length = msg.readUInt16LE(at);
  const offset = msg.readUInt32LE(at + 4);
  if (length === 0) return '';
  if (offset + length > msg.length) return null;
  return { bytes: msg.subarray(offset, offset + length) };
}

function decodeString(secBuf, unicode) {
  if (secBuf === '' || secBuf === null) return '';
  return secBuf.bytes.toString(unicode ? 'utf16le' : 'latin1');
}

function parseType3(msg) {
  // Fixed layout: domain secbuf at 28, user secbuf at 36, flags at 60.
  if (msg.length < 44) return null;
  const domainBuf = readSecurityBuffer(msg, 28);
  const userBuf = readSecurityBuffer(msg, 36);
  if (domainBuf === null || userBuf === null) return null;

  let unicode;
  if (msg.length >= 64) {
    unicode = (msg.readUInt32LE(60) & 0x00000001) !== 0;
  } else {
    // Old/minimal clients omit the flags: UTF-16LE ASCII text contains
    // interleaved NUL bytes, so their presence is a reliable signal.
    unicode = userBuf !== '' && userBuf.bytes.includes(0);
  }

  const user = decodeString(userBuf, unicode).trim();
  const domain = decodeString(domainBuf, unicode).trim();
  if (!user) return null;
  return { user, domain };
}

function deny(res) {
  res.set('WWW-Authenticate', 'NTLM');
  res.status(401).send('Authentication required');
}

function ntlmIdent(req, res, next) {
  // Identity sticks to the TCP connection once the handshake completed.
  if (req.socket.ntlmIdentity) {
    req.user = req.socket.ntlmIdentity;
    return next();
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('NTLM ')) {
    return deny(res);
  }

  let msg;
  try {
    msg = Buffer.from(auth.slice(5), 'base64');
  } catch (err) {
    return deny(res);
  }
  if (msg.length < 12 || msg.toString('latin1', 0, 8) !== NTLM_SIGNATURE) {
    return deny(res);
  }

  const messageType = msg.readUInt32LE(8);

  if (messageType === 1) {
    res.set('WWW-Authenticate', 'NTLM ' + buildType2Challenge().toString('base64'));
    return res.status(401).send('NTLM challenge');
  }

  if (messageType === 3) {
    const identity = parseType3(msg);
    if (!identity) return deny(res);
    const upn = identity.domain ? `${identity.user}@${identity.domain}` : identity.user;
    req.socket.ntlmIdentity = { ...identity, upn };
    req.user = req.socket.ntlmIdentity;
    // UNVERIFIED identity — log every claim with its source for audit.
    console.log(`[ntlm-ident] UNVERIFIED identity claim '${upn}' from ${req.ip}`);
    return next();
  }

  return deny(res);
}

module.exports = { ntlmIdent };
