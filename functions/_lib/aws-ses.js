// Self-contained AWS SigV4 + SES v2 SendEmail.
//
// Cloudflare Workers can call any HTTPS endpoint via fetch() , for AWS we just
// need to sign the request properly with SigV4. The Web Crypto API
// (crypto.subtle) is available in the Workers runtime, so we sign without
// pulling in an SDK. Total surface: ~80 lines, no dependencies.
//
// Used by functions/api/submit.js to notify the editor + send a confirmation
// to the parent after each successful submission.

const ENC = new TextEncoder();
function utf8(s){ return ENC.encode(s); }
function toHex(bytes){
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input){
  const buf = await crypto.subtle.digest('SHA-256', typeof input === 'string' ? utf8(input) : input);
  return toHex(new Uint8Array(buf));
}

async function hmac(key, data){
  const k = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? utf8(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? utf8(data) : data);
  return new Uint8Array(sig);
}

async function signSigV4({ method, host, path, region, service, accessKey, secretKey, body }){
  const now = new Date();
  // Format: YYYYMMDDTHHMMSSZ (strip dashes, colons, milliseconds)
  const amzDate   = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(body || '');
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest =
    `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign =
    `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  // Derive signing key
  const kDate    = await hmac('AWS4' + secretKey, dateStamp);
  const kRegion  = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  return {
    'content-type': 'application/json',
    'host': host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'authorization': `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Send a plaintext email via SES v2 SendEmail.
 *   await sendSesEmail({ env, from, to, subject, text, replyTo });
 *
 * env must carry AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION
 * (defaults to us-east-1 if absent). Throws on non-2xx.
 *
 * `replyTo` is optional , when set, recipients hitting reply land at this
 * address instead of `from`. Useful when from-address (e.g. editor@…)
 * isn't a real inbox.
 */
export async function sendSesEmail({ env, from, to, subject, text, replyTo }){
  if (!env || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY){
    throw new Error('SES credentials missing (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars on the Pages project)');
  }
  const region = env.AWS_REGION || 'us-east-1';
  const host   = `email.${region}.amazonaws.com`;
  const path   = '/v2/email/outbound-emails';

  const payload = {
    FromEmailAddress: from,
    Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body:    { Text:    { Data: text,    Charset: 'UTF-8' } },
      },
    },
  };
  if (replyTo){
    payload.ReplyToAddresses = Array.isArray(replyTo) ? replyTo : [replyTo];
  }
  const body = JSON.stringify(payload);

  const headers = await signSigV4({
    method: 'POST', host, path, region, service: 'ses',
    accessKey: env.AWS_ACCESS_KEY_ID, secretKey: env.AWS_SECRET_ACCESS_KEY,
    body,
  });

  const res = await fetch(`https://${host}${path}`, { method: 'POST', headers, body });
  if (!res.ok){
    const txt = await res.text().catch(() => '');
    throw new Error(`SES SendEmail ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}
