// Netlify Serverless Function — DocuSign JWT Integration
// LIS Personalize — Performance Incorporações

const https = require('https');
const crypto = require('crypto');

// ── CONFIG (variáveis de ambiente no Netlify) ──
const INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
const USER_ID         = process.env.DOCUSIGN_USER_ID;
const ACCOUNT_ID      = process.env.DOCUSIGN_ACCOUNT_ID;
const TEMPLATE_ID     = process.env.DOCUSIGN_TEMPLATE_ID;
const PRIVATE_KEY     = process.env.DOCUSIGN_PRIVATE_KEY?.replace(/\\n/g, '\n');
const BASE_URL        = 'https://demo.docusign.net/restapi';
const AUTH_URL        = 'account-d.docusign.com';

// ── JWT HELPER ──
function base64url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJWT() {
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
  const sig = sign.sign(PRIVATE_KEY, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${payload}.${sig}`;
}

// ── HTTP HELPER ──
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
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

// ── GET ACCESS TOKEN ──
async function getAccessToken() {
  const jwtToken = makeJWT();
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwtToken}`;
  const res = await httpsPost(AUTH_URL, '/oauth/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  const json = JSON.parse(res.body);
  if (!json.access_token) throw new Error(`Auth failed: ${res.body}`);
  return json.access_token;
}

// ── GET ACCOUNT ID (resolve short ID → UUID) ──
async function getAccountUUID(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: AUTH_URL, path: '/oauth/userinfo', method: 'GET',
        headers: { Authorization: `Bearer ${token}` } },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          const info = JSON.parse(raw);
          const acct = info.accounts?.find(a => a.account_id === ACCOUNT_ID || a.account_name);
          resolve(acct?.account_id || info.accounts?.[0]?.account_id);
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── CREATE ENVELOPE ──
async function createEnvelope(token, accountUUID, clientData) {
  const { clientName, clientEmail, clientCPF, unit, plantLabel,
          kitName, total, installments, parcelValue, today } = clientData;

  const envelope = {
    templateId: TEMPLATE_ID,
    templateRoles: [
      {
        roleName: 'Cliente',
        name: clientName,
        email: clientEmail,
        routingOrder: '1',
        tabs: {
          textTabs: [
            { tabLabel: 'unidade',    value: String(unit) },
            { tabLabel: 'cpf',        value: clientCPF },
            { tabLabel: 'planta',     value: plantLabel },
            { tabLabel: 'kit',        value: kitName },
            { tabLabel: 'total',      value: `R$ ${total}` },
            { tabLabel: 'parcelas',   value: String(installments) },
            { tabLabel: 'parcela',    value: `R$ ${parcelValue}` },
            { tabLabel: 'data',       value: today },
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
    emailSubject: `LIS Personalize — Termo de Opções Unidade ${unit} — ${clientName}`,
    emailBlurb: `Prezado(a) ${clientName}, segue o Termo de Opções para assinatura eletrônica referente à sua unidade ${unit} no empreendimento LIS.`
  };

  const path = `/restapi/v2.1/accounts/${accountUUID}/envelopes`;
  const hostname = 'demo.docusign.net';
  const res = await httpsPost(hostname, path, {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }, envelope);

  return { status: res.status, body: JSON.parse(res.body) };
}

// ── GET EMBEDDED SIGNING URL ──
async function getSigningUrl(token, accountUUID, envelopeId, clientName, clientEmail, returnUrl) {
  const body = {
    returnUrl,
    authenticationMethod: 'none',
    email: clientEmail,
    userName: clientName,
    clientUserId: '1001',
  };

  // First update envelope to add clientUserId for embedded signing
  // Patch the recipient
  const patchPath = `/restapi/v2.1/accounts/${accountUUID}/envelopes/${envelopeId}/recipients`;
  const patchBody = {
    signers: [{
      email: clientEmail,
      name: clientName,
      recipientId: '1',
      clientUserId: '1001',
      routingOrder: '1',
    }]
  };

  await new Promise((resolve, reject) => {
    const data = JSON.stringify(patchBody);
    const req = https.request({
      hostname: 'demo.docusign.net',
      path: patchPath,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => { res.on('data', ()=>{}); res.on('end', resolve); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  // Get signing URL
  const viewPath = `/restapi/v2.1/accounts/${accountUUID}/envelopes/${envelopeId}/views/recipient`;
  const res = await httpsPost('demo.docusign.net', viewPath, {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }, body);

  const json = JSON.parse(res.body);
  return json.url;
}

// ── MAIN HANDLER ──
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const clientData = JSON.parse(event.body);
    const returnUrl = clientData.returnUrl || 'https://lis-personalize.netlify.app?signed=true';

    console.log('Getting access token...');
    const token = await getAccessToken();

    console.log('Getting account UUID...');
    const accountUUID = await getAccountUUID(token);
    console.log('Account UUID:', accountUUID);

    console.log('Creating envelope...');
    const { status, body: envBody } = await createEnvelope(token, accountUUID, clientData);
    console.log('Envelope status:', status, envBody);

    if (status !== 201 || !envBody.envelopeId) {
      return { statusCode: 500, headers,
        body: JSON.stringify({ error: 'Erro ao criar envelope', details: envBody }) };
    }

    console.log('Getting signing URL...');
    const signingUrl = await getSigningUrl(
      token, accountUUID, envBody.envelopeId,
      clientData.clientName, clientData.clientEmail, returnUrl
    );

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ success: true, signingUrl, envelopeId: envBody.envelopeId })
    };

  } catch (err) {
    console.error('DocuSign error:', err);
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: err.message }) };
  }
};
