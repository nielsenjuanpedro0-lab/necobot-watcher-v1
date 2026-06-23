// NecoBot YCloud Watcher — detecta asignaciones sin extensión
// Desplegado en EasyPanel, corre 24/7, actualiza Supabase
'use strict';

// ── Config ────────────────────────────────────────────────────────
const YC_BASE    = 'https://www.ycloud.com';
const SUPA_URL   = 'https://qukgtlwessujumdmfgnm.supabase.co/rest/v1';
const SUPA_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1a2d0bHdlc3N1anVtZG1mZ25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM3MjY1MCwiZXhwIjoyMDg3OTQ4NjUwfQ.iWPH9PEGNixiZUPl8f-pJLv7dl6wBeOEw9psOnlrMq4';
const POLL_MS    = 10_000;   // cada 10s

// ── Estado en memoria ─────────────────────────────────────────────
// phone (sin +) → { isAssigned: bool, agentId: string|null, convId: string }
const prevStates = {};

// ── Logging ───────────────────────────────────────────────────────
const log  = (...a) => console.log('[watcher]', new Date().toISOString().slice(11,19), ...a);
const warn = (...a) => console.warn('[watcher]', new Date().toISOString().slice(11,19), ...a);

// ── Auth: Bearer token estático desde env var ─────────────────────
// Cómo obtener el token:
//   1. Abrí https://www.ycloud.com/smb/inbox en Chrome
//   2. DevTools → Network → filtrá por "api/inbox"
//   3. Copiá el header Authorization de cualquier request
//   4. Seteá en EasyPanel: YC_TOKEN=Bearer eyJ...
function getAuthToken() {
  const token = process.env.YC_TOKEN;
  if (!token) {
    warn('YC_TOKEN no configurado — detección de asignaciones deshabilitada');
    warn('Para habilitarla: obtené el token de YCloud DevTools y seteá YC_TOKEN en EasyPanel');
    return null;
  }
  return token;
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
  const token = getAuthToken();
  if (token) h['Authorization'] = token;
  return h;
}

// ── Obtener lista de conversaciones del inbox ─────────────────────
const INBOX_ENDPOINTS = [
  { url: `${YC_BASE}/api/inbox/allWithSmb?source=inbox`, method: 'GET'  },
  { url: `${YC_BASE}/api/inbox/all?source=inbox`,        method: 'GET'  },
  { url: `${YC_BASE}/api/inbox/conversation/list`,       method: 'POST', body: { pageSize: 200 } },
];

async function fetchInbox() {
  const token = getAuthToken();
  if (!token) return undefined;  // sin token, skip silencioso

  for (const ep of INBOX_ENDPOINTS) {
    try {
      const opts = { method: ep.method, headers: buildHeaders() };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const res = await fetch(ep.url, opts);
      if (res.status === 401) {
        warn('YCloud 401 — token expirado. Renovar YC_TOKEN en EasyPanel:');
        warn('  1. Chrome → https://www.ycloud.com/smb/inbox');
        warn('  2. DevTools → Network → cualquier request a /api/inbox');
        warn('  3. Copiar header Authorization → actualizar variable en EasyPanel');
        return null;
      }
      if (!res.ok) { warn('inbox', ep.url.slice(-40), res.status); continue; }
      const data = await res.json();
      return data;
    } catch (e) {
      warn('fetchInbox error:', ep.url.slice(-40), e.message);
    }
  }
  return undefined;  // error de red, reintentar en próximo tick
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
    if (phone === '5492262317472') continue;  // número del local

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
  if (!convId || !getAuthToken()) return false;
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
  const data = await fetchInbox();

  if (data === null) return;  // 401 ya logueado con instrucciones
  if (!data) return;          // error de red, reintentar en próximo tick

  const conversations = parseConversations(data);
  log(`inbox: ${conversations.length} conversaciones`);

  const convMap = {};
  for (const c of conversations) {
    for (const v of phoneVariants(c.phone)) convMap[v] = c.convId;
  }

  for (const { phone, isAssigned, agentId, convId } of conversations) {
    const prev = prevStates[phone];

    if (prev === undefined) {
      prevStates[phone] = { isAssigned, agentId, convId };
      continue;
    }

    const cambioAAsignado    = !prev.isAssigned && isAssigned;
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

  await handleExpiredPaused(convMap);
}

// ── Loop independiente de expiración (no requiere auth YCloud) ───
async function expiryLoop() {
  try {
    await handleExpiredPaused({});  // convMap vacío — sin desasignar en YCloud
  } catch (e) {
    warn('expiryLoop error:', e.message);
  }
  setTimeout(expiryLoop, 30_000);  // cada 30s
}

// ── Arranque ──────────────────────────────────────────────────────
async function main() {
  log('iniciando NecoBot YCloud Watcher');

  const token = getAuthToken();
  if (token) {
    log('YC_TOKEN detectado — detección de asignaciones activa');
  } else {
    log('YC_TOKEN ausente — solo loop de expiración activo');
  }

  // Loop de expiración siempre activo, independiente del token YCloud
  expiryLoop();

  if (!token) return;

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
