// Netlify Serverless Function — DocuSign JWT Integration
// LIS Personalize — envia contrato HTML gerado pelo sistema

const https  = require('https');
const crypto = require('crypto');

const INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY;
const USER_ID         = process.env.DOCUSIGN_USER_ID;
const ACCOUNT_ID      = process.env.DOCUSIGN_ACCOUNT_ID;
const AUTH_URL        = 'account-d.docusign.com';

function getPrivateKey() {
  let key = process.env.DOCUSIGN_PRIVATE_KEY || '';
  key = key.replace(/\\n/g, '\n');
  if (!key.includes('\n')) {
    key = key
      .replace('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\n')
      .replace('-----END RSA PRIVATE KEY-----', '\n-----END RSA PRIVATE KEY-----');
    const lines  = key.split('\n');
    const header = lines[0];
    const footer = lines[lines.length - 1];
    const body   = lines.slice(1, -1).join('');
    key = [header, ...(body.match(/.{1,64}/g) || []), footer].join('\n');
  }
  return key;
}

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function makeJWT(privateKey) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = base64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: INTEGRATION_KEY, sub: USER_ID,
    aud: AUTH_URL, iat: now, exp: now + 3600,
    scope: 'signature impersonation'
  }));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return `${header}.${payload}.${sig}`;
}

function request(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const req  = https.request(
      { hostname, path, method,
        headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(data) } : headers },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getAccessToken(privateKey) {
  const assertion = makeJWT(privateKey);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`;
  const res  = await request('POST', AUTH_URL, '/oauth/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  const json = JSON.parse(res.body);
  if (!json.access_token) throw new Error(`Auth failed: ${res.body}`);
  return json.access_token;
}

async function getAccountUUID(token) {
  const res  = await request('GET', AUTH_URL, '/oauth/userinfo',
    { 'Authorization': `Bearer ${token}` });
  const info = JSON.parse(res.body);
  return (info.accounts?.find(a => a.account_id === ACCOUNT_ID) || info.accounts?.[0])?.account_id;
}

async function createEnvelope(token, accountUUID, d) {
  const htmlContent = Buffer.from(d.contractHTML, 'base64').toString('utf-8');
  const docB64      = Buffer.from(htmlContent).toString('base64');

  const envelope = {
    emailSubject: `LIS Personalize — Termo de Opções Unidade ${d.unit} — ${d.clientName}`,
    emailBlurb:   `Prezado(a) ${d.clientName}, segue o Termo de Opções para assinatura da unidade ${d.unit} no empreendimento LIS.`,
    documents: [{
      documentId:     '1',
      name:           `Termo_Opcoes_Unidade_${d.unit}.html`,
      fileExtension:  'html',
      documentBase64: docB64,
    }],
    recipients: {
      signers: [
        {
          recipientId:  '1',
          routingOrder: '1',
          name:         d.clientName,
          email:        d.clientEmail,
          clientUserId: '1001',
          tabs: {
            signHereTabs: [{
              anchorString:  'Assinatura do Comprador',
              anchorXOffset: '0',
              anchorYOffset: '25',
              anchorUnits:   'pixels',
            }],
            dateSignedTabs: [{
              anchorString:  'Assinatura do Comprador',
              anchorXOffset: '250',
              anchorYOffset: '25',
              anchorUnits:   'pixels',
            }],
          }
        },
        {
          recipientId:  '2',
          routingOrder: '2',
          name:         'AC Arqui',
          email:        'ac@amandacrespoarq.com.br',
          tabs: {
            signHereTabs: [{
              anchorString:  'AC Arqui',
              anchorXOffset: '0',
              anchorYOffset: '25',
              anchorUnits:   'pixels',
            }],
          }
        }
      ]
    },
    status: 'sent'
  };

  const res = await request('POST', 'demo.docusign.net',
    `/restapi/v2.1/accounts/${accountUUID}/envelopes`,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    envelope);

  return { status: res.status, body: JSON.parse(res.body) };
}

async function getSigningUrl(token, accountUUID, envelopeId, name, email, returnUrl) {
  const body = {
    returnUrl,
    authenticationMethod: 'none',
    email,
    userName:     name,
    clientUserId: '1001',
  };
  const res  = await request('POST', 'demo.docusign.net',
    `/restapi/v2.1/accounts/${accountUUID}/envelopes/${envelopeId}/views/recipient`,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body);
  const json = JSON.parse(res.body);
  if (!json.url) throw new Error(`Signing URL failed: ${res.body}`);
  return json.url;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers, body:'' };
  if (event.httpMethod !== 'POST')    return { statusCode:405, headers, body: JSON.stringify({error:'Method not allowed'}) };

  try {
    const d          = JSON.parse(event.body);
    const returnUrl  = `${d.returnUrl || 'https://lispersonalize.netlify.app'}?event=signing_complete`;
    const privateKey = getPrivateKey();

    const token       = await getAccessToken(privateKey);
    const accountUUID = await getAccountUUID(token);
    const { status, body: envBody } = await createEnvelope(token, accountUUID, d);

    if (!envBody.envelopeId) {
      return { statusCode:500, headers,
        body: JSON.stringify({ error:'Erro ao criar envelope', details: envBody }) };
    }

    const signingUrl = await getSigningUrl(
      token, accountUUID, envBody.envelopeId,
      d.clientName, d.clientEmail, returnUrl
    );

    return { statusCode:200, headers,
      body: JSON.stringify({ success:true, signingUrl, envelopeId: envBody.envelopeId }) };

  } catch(err) {
    console.error('Error:', err.message);
    return { statusCode:500, headers,
      body: JSON.stringify({ error: err.message }) };
  }
};
