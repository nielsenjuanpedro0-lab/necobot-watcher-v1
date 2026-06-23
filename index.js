// NecoBot YCloud Watcher — detecta asignaciones sin extensión
// Desplegado en EasyPanel, corre 24/7, actualiza Supabase
'use strict';

const puppeteer = require('puppeteer');

// ── Config ────────────────────────────────────────────────────────
const YC_BASE    = 'https://www.ycloud.com';
const YC_EMAIL   = process.env.YC_EMAIL;
const YC_PASSWORD= process.env.YC_PASSWORD;
const SUPA_URL   = 'https://qukgtlwessujumdmfgnm.supabase.co/rest/v1';
const SUPA_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1a2d0bHdlc3N1anVtZG1mZ25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM3MjY1MCwiZXhwIjoyMDg3OTQ4NjUwfQ.iWPH9PEGNixiZUPl8f-pJLv7dl6wBeOEw9psOnlrMq4';
const POLL_MS    = 10_000;   // cada 10s
const REAUTH_MS  = 3 * 60 * 60 * 1000; // reloguear cada 3h

// ── Estado en memoria ─────────────────────────────────────────────
// phone (sin +) → { isAssigned: bool, agentId: string|null, convId: string }
const prevStates = {};

let authToken  = null;
let cookieStr  = null;
let lastAuth   = 0;

// ── Logging ───────────────────────────────────────────────────────
const log  = (...a) => console.log('[watcher]', new Date().toISOString().slice(11,19), ...a);
const warn = (...a) => console.warn('[watcher]', new Date().toISOString().slice(11,19), ...a);

// ── Autenticar con Puppeteer ──────────────────────────────────────
async function authenticate() {
  if (!YC_EMAIL || !YC_PASSWORD) {
    warn('YC_EMAIL / YC_PASSWORD no configurados');
    return false;
  }
  log('autenticando en YCloud...');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
        '--disable-dev-shm-usage', '--no-first-run', '--no-zygote'
      ]
    });

    const page = await browser.newPage();
    let captured = null;

    // Capturar token de las requests que hace YCloud
    await page.setRequestInterception(true);
    page.on('request', req => {
      const auth = req.headers()['authorization'];
      if (auth && !auth.includes(SUPA_KEY) && auth.startsWith('Bearer ')) {
        captured = auth;
      }
      req.continue();
    });

    // Login
    await page.goto(`${YC_BASE}/login`, { waitUntil: 'networkidle2', timeout: 45_000 });
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="mail"]', { timeout: 15_000 });
    await page.type('input[type="email"], input[name="email"], input[placeholder*="mail"]', YC_EMAIL, { delay: 50 });
    await page.type('input[type="password"]', YC_PASSWORD, { delay: 50 });
    await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 });

    // Navegar al inbox para que YCloud dispare requests autenticadas
    await page.goto(`${YC_BASE}/smb/inbox`, { waitUntil: 'networkidle2', timeout: 30_000 });
    await new Promise(r => setTimeout(r, 4_000));

    const raw = await page.cookies();
    cookieStr = raw.map(c => `${c.name}=${c.value}`).join('; ');
    authToken = captured;
    lastAuth  = Date.now();

    log('auth OK — token:', authToken ? authToken.slice(0, 40) + '...' : 'null');
    return !!authToken;
  } catch (e) {
    warn('auth error:', e.message);
    return false;
  } finally {
    if (browser) await browser.close();
  }
}

// ── Headers para llamadas internas YCloud ─────────────────────────
function buildHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Referer': `${YC_BASE}/smb/inbox`,
    'Origin': YC_BASE,
  };
  if (authToken) h['Authorization'] = authToken;
  if (cookieStr) h['Cookie'] = cookieStr;
  return h;
}

// ── Obtener lista de conversaciones del inbox ─────────────────────
const INBOX_ENDPOINTS = [
  { url: `${YC_BASE}/api/inbox/allWithSmb?source=inbox`, method: 'GET'  },
  { url: `${YC_BASE}/api/inbox/all?source=inbox`,        method: 'GET'  },
  { url: `${YC_BASE}/api/inbox/conversation/list`,       method: 'POST', body: { pageSize: 200 } },
];

async function fetchInbox() {
  for (const ep of INBOX_ENDPOINTS) {
    try {
      const opts = { method: ep.method, headers: buildHeaders() };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const res = await fetch(ep.url, opts);
      if (res.status === 401) return null;   // señal de re-auth
      if (!res.ok) { warn('inbox', ep.url.slice(-40), res.status); continue; }
      const data = await res.json();
      // Log estructura la primera vez
      if (Object.keys(prevStates).length === 0) {
        const sample = (data?.list ?? data?.data ?? data?.conversations ?? data?.items ?? (Array.isArray(data) ? data : []))[0];
        if (sample) log('estructura inbox (primer item):', Object.keys(sample).join(', ').slice(0, 200));
      }
      return data;
    } catch (e) {
      warn('fetchInbox error:', ep.url.slice(-40), e.message);
    }
  }
  return undefined;  // error, pero no 401
}

// ── Parsear items del inbox → { phone, convId, isAssigned, agentId } ──
function phoneVariants(phone) {
  const p = phone.replace(/\D/g, '');
  const s = new Set([p]);
  if (p.startsWith('549') && p.length === 13) { s.add('54' + p.slice(3)); }
  else if (p.startsWith('54') && !p.startsWith('549') && p.length === 12) { s.add('549' + p.slice(2)); }
  else if (p.length === 10) { s.add('54' + p); s.add('549' + p); }
  return [...s];
}

function parseConversations(data) {
  const items = data?.list ?? data?.data ?? data?.conversations ?? data?.records ??
    data?.pageList ?? data?.items ?? data?.inboxList ?? (Array.isArray(data) ? data : null);
  if (!Array.isArray(items)) return [];

  const result = [];
  for (const item of items) {
    const rawPhone =
      item.customerPhone ?? item.phone ?? item.waId ??
      item.contact?.phone ?? item.contact?.waId ?? item.contact?.phoneNumber ??
      item.customer?.phone ?? item.to ?? item.from ?? '';

    const phone = rawPhone.replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 15) continue;
    // Excluir números del propio negocio
    if (phone === '5492262317472') continue;

    const convId = String(
      item.conversationId ?? item.inboxConversationId ?? item.inbox_conversation_id ??
      item.chatId ?? item.id ?? ''
    );

    const agentId =
      item.agentId ?? item.assigneeId ?? item.assignedAgentId ??
      item.agent?.id ?? item.assignee?.id ?? item.assignedTo ?? null;

    const isAssigned = !!agentId && agentId !== '' && agentId !== 'null';

    result.push({ phone, convId, isAssigned, agentId: isAssigned ? String(agentId) : null });
  }
  return result;
}

// ── Supabase: actualizar estado ───────────────────────────────────
const SUPA_HEADERS = {
  apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json'
};

async function supabasePatch(phone, estado) {
  const variants = [phone, `+${phone}`];
  for (const v of variants) {
    await fetch(`${SUPA_URL}/memoria_ram?telefono=eq.${encodeURIComponent(v)}`, {
      method: 'PATCH', headers: SUPA_HEADERS, body: JSON.stringify({ estado_conversacion: estado })
    }).catch(e => warn('supabase patch error:', e.message));
  }
  log(`Supabase: ...${phone.slice(-6)} → ${estado.slice(0, 30)}`);
}

async function supabaseGetExpired() {
  try {
    const res = await fetch(
      `${SUPA_URL}/memoria_ram?select=telefono,estado_conversacion&or=(estado_conversacion.like.PAUSADO:*,estado_conversacion.like.DERIVADO:*)`,
      { headers: SUPA_HEADERS }
    );
    return await res.json();
  } catch (e) {
    warn('supabase get expired error:', e.message);
    return [];
  }
}

// ── YCloud: desasignar conversación (cuando pausa expira) ─────────
async function unassignConv(convId) {
  if (!convId) return false;
  const payloads = [
    { conversationId: convId, unassigned: true, agentId: '', teamId: '' },
    { inboxConversationId: convId, unassigned: true },
    { id: convId, agentId: '', unassigned: true },
  ];
  for (const payload of payloads) {
    try {
      const res = await fetch(`${YC_BASE}/api/inbox/conversation/transfer`, {
        method: 'POST', headers: buildHeaders(), body: JSON.stringify(payload)
      });
      if (res.ok) { log(`desasignado convId ${convId}`); return true; }
    } catch (e) { warn('unassign error:', e.message); }
  }
  return false;
}

// ── Chequear conversaciones pausadas/derivadas que expiraron ──────
async function handleExpiredPaused(convMap) {
  const rows = await supabaseGetExpired();
  if (!Array.isArray(rows)) return;
  const now = Date.now();

  for (const row of rows) {
    const estado = row.estado_conversacion;
    const prefix = estado.startsWith('PAUSADO:') ? 'PAUSADO:' : estado.startsWith('DERIVADO:') ? 'DERIVADO:' : null;
    if (!prefix) continue;

    const isoStr = estado.slice(prefix.length);
    const expiry = new Date(isoStr);
    if (isNaN(expiry.getTime()) || now < expiry.getTime()) continue;

    const phone = row.telefono.replace(/^\+/, '');
    log(`pausa expirada: ...${phone.slice(-6)}`);

    await supabasePatch(phone, 'ACTIVO');

    // Buscar convId en el mapa de inbox y desasignar en YCloud
    let convId = null;
    for (const v of phoneVariants(phone)) {
      if (convMap[v]) { convId = convMap[v]; break; }
    }
    if (convId) await unassignConv(convId);
    else warn('no encontré convId para desasignar:', phone);
  }
}

// ── Loop principal de polling ─────────────────────────────────────
async function poll() {
  // Re-auth periódico (cada 3h)
  if (Date.now() - lastAuth > REAUTH_MS) {
    log('re-autenticando por timeout');
    await authenticate();
  }

  const data = await fetchInbox();

  if (data === null) {
    warn('401 — re-autenticando');
    await authenticate();
    return;
  }
  if (!data) return;  // error de red, reintentar en próximo tick

  const conversations = parseConversations(data);
  log(`inbox: ${conversations.length} conversaciones`);

  // Mapa convId para unassign de pausas expiradas
  const convMap = {};
  for (const c of conversations) {
    for (const v of phoneVariants(c.phone)) convMap[v] = c.convId;
  }

  for (const { phone, isAssigned, agentId, convId } of conversations) {
    const prev = prevStates[phone];

    if (prev === undefined) {
      // Primera vez que vemos esta conv — solo registrar, sin cambiar Supabase
      prevStates[phone] = { isAssigned, agentId, convId };
      continue;
    }

    const cambioAAsignado   = !prev.isAssigned && isAssigned;
    const cambioADesasignado = prev.isAssigned && !isAssigned;

    if (cambioAAsignado) {
      log(`asignado: ...${phone.slice(-6)} → agente ${agentId} → PAUSADO 12h`);
      const expiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      await supabasePatch(phone, `PAUSADO:${expiry}`);
    } else if (cambioADesasignado) {
      log(`desasignado: ...${phone.slice(-6)} → ACTIVO`);
      await supabasePatch(phone, 'ACTIVO');
    }

    prevStates[phone] = { isAssigned, agentId, convId };
  }

  // Chequear pausas expiradas
  await handleExpiredPaused(convMap);
}

// ── Arranque ──────────────────────────────────────────────────────
async function main() {
  log('iniciando NecoBot YCloud Watcher');

  const ok = await authenticate();
  if (!ok) {
    warn('auth fallida. reintentando en 60s...');
    setTimeout(main, 60_000);
    return;
  }

  async function loop() {
    try {
      await poll();
    } catch (e) {
      warn('poll error:', e.message);
    }
    setTimeout(loop, POLL_MS);
  }

  await loop();
}

main();
