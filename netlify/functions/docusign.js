// Netlify Serverless Function — DocuSign JWT Integration
// LIS Personalize — Performance Incorporações

const https = require('https');
const crypto = require('crypto');

const INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
const USER_ID         = process.env.DOCUSIGN_USER_ID;
const ACCOUNT_ID      = process.env.DOCUSIGN_ACCOUNT_ID;
const TEMPLATE_ID     = process.env.DOCUSIGN_TEMPLATE_ID;
const AUTH_URL        = 'account-d.docusign.com';

// ── Fix private key — handle all possible formats ──
function getPrivateKey() {
  let key = process.env.DOCUSIGN_PRIVATE_KEY || '';
  // Replace literal \n with actual newlines
  key = key.replace(/\\n/g, '\n');
  // If key doesn't have proper line breaks, reformat it
  if (!key.includes('\n')) {
    // Try to insert newlines at correct positions
    key = key
      .replace('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\n')
      .replace('-----END RSA PRIVATE KEY-----', '\n-----END RSA PRIVATE KEY-----');
    // Split the base64 body into 64-char lines
    const lines = key.split('\n');
    const header = lines[0];
    const footer = lines[lines.length - 1];
    const body = lines.slice(1, -1).join('');
    const bodyLines = body.match(/.{1,64}/g) || [];
    key = [header, ...bodyLines, footer].join('\n');
  }
  return key;
}

// ── JWT ──
function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJWT(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: INTEGRATION_KEY,
    sub: USER_ID,
    aud: AUTH_URL,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation'
  }));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${payload}.${sig}`;
}

// ── HTTP helpers ──
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpsPut(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'PUT',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Get access token ──
async function getAccessToken(privateKey) {
  const jwtToken = makeJWT(privateKey);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwtToken}`;
  const res = await httpsPost(AUTH_URL, '/oauth/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  const json = JSON.parse(res.body);
  if (!json.access_token) throw new Error(`Auth failed: ${res.body}`);
  return json.access_token;
}

// ── Get account UUID ──
async function getAccountUUID(token) {
  const res = await httpsGet(AUTH_URL, '/oauth/userinfo',
    { 'Authorization': `Bearer ${token}` });
  const info = JSON.parse(res.body);
  const acct = info.accounts?.find(a => a.account_id === ACCOUNT_ID) || info.accounts?.[0];
  return acct?.account_id;
}

// ── Create envelope ──
async function createEnvelope(token, accountUUID, d) {
  const envelope = {
    templateId: TEMPLATE_ID,
    templateRoles: [
      {
        roleName: 'Cliente',
        name: d.clientName,
        email: d.clientEmail,
        clientUserId: '1001',
        routingOrder: '1',
        tabs: {
          textTabs: [
            { tabLabel: 'unidade',  value: String(d.unit) },
            { tabLabel: 'cpf',      value: d.clientCPF },
            { tabLabel: 'planta',   value: d.plantLabel },
            { tabLabel: 'kit',      value: d.kitName },
            { tabLabel: 'total',    value: `R$ ${d.total}` },
            { tabLabel: 'parcelas', value: String(d.installments) },
            { tabLabel: 'parcela',  value: `R$ ${d.parcelValue}` },
            { tabLabel: 'data',     value: d.today },
          ]
        }
      },
      {
        roleName: 'Empresa',
        name: 'AC Arqui',
        email: 'ac@amandacrespoarq.com.br',
        routingOrder: '2',
      }
    ],
    status: 'sent',
    emailSubject: `LIS Personalize — Termo de Opções Unidade ${d.unit} — ${d.clientName}`,
    emailBlurb: `Prezado(a) ${d.clientName}, segue o Termo de Opções para assinatura referente à unidade ${d.unit} no empreendimento LIS.`
  };

  const res = await httpsPost('demo.docusign.net',
    `/restapi/v2.1/accounts/${accountUUID}/envelopes`,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    envelope);

  return { status: res.status, body: JSON.parse(res.body) };
}

// ── Get embedded signing URL ──
async function getSigningUrl(token, accountUUID, envelopeId, clientName, clientEmail, returnUrl) {
  const body = {
    returnUrl,
    authenticationMethod: 'none',
    email: clientEmail,
    userName: clientName,
    clientUserId: '1001',
  };

  const res = await httpsPost('demo.docusign.net',
    `/restapi/v2.1/accounts/${accountUUID}/envelopes/${envelopeId}/views/recipient`,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body);

  const json = JSON.parse(res.body);
  if (!json.url) throw new Error(`Signing URL failed: ${res.body}`);
  return json.url;
}

// ── Main handler ──
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const clientData = JSON.parse(event.body);
    const returnUrl = `${clientData.returnUrl || 'https://lispersonalize.netlify.app'}?event=signing_complete`;

    // Get and fix private key
    const privateKey = getPrivateKey();
    console.log('Private key length:', privateKey.length);
    console.log('Private key starts with:', privateKey.substring(0, 40));

    const token = await getAccessToken(privateKey);
    console.log('Token OK');

    const accountUUID = await getAccountUUID(token);
    console.log('Account UUID:', accountUUID);

    const { status, body: envBody } = await createEnvelope(token, accountUUID, clientData);
    console.log('Envelope status:', status);

    if (!envBody.envelopeId) {
      return { statusCode: 500, headers,
        body: JSON.stringify({ error: 'Erro ao criar envelope', details: envBody }) };
    }

    const signingUrl = await getSigningUrl(
      token, accountUUID, envBody.envelopeId,
      clientData.clientName, clientData.clientEmail, returnUrl
    );

    return { statusCode: 200, headers,
      body: JSON.stringify({ success: true, signingUrl, envelopeId: envBody.envelopeId }) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: err.message }) };
  }
};
