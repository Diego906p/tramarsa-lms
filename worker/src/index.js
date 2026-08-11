const FIREBASE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  return allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}
function origenPermitido(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  return allowed.includes(origin);
}
function base64UrlBytes(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function verifyFirebaseToken(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new Error('Autenticación requerida.');
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error('El token no es válido.');
  const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(encodedHeader)));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(encodedPayload)));
  const jwks = await (await fetch(FIREBASE_JWKS)).json();
  const jwk = (jwks.keys || []).find(key => key.kid === header.kid);
  if (!jwk) throw new Error('El token no es válido.');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valido = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlBytes(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
  const ahora = Math.floor(Date.now() / 1000);
  if (!valido || payload.aud !== env.FIREBASE_PROJECT_ID || payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}` || payload.exp <= ahora || !payload.sub) {
    throw new Error('El token no es válido o expiró.');
  }
  return { token, uid: payload.sub, email: String(payload.email || '').toLowerCase() };
}
function rutaValida(ruta) {
  return typeof ruta === 'string' && ruta.length > 3 && ruta.length < 300 && !ruta.startsWith('/') && !ruta.includes('..') && /^[a-zA-Z0-9_./-]+$/.test(ruta);
}
async function firestoreGet(path, token, env) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return null;
  return response.json();
}
function value(document, field) { return document && document.fields && document.fields[field]; }
async function admin(identity, env) {
  const bootstrap = (env.ADMIN_EMAILS || '').split(',').map(v => v.trim().toLowerCase());
  if (bootstrap.includes(identity.email)) return true;
  return !!await firestoreGet(`administradores/${identity.uid}`, identity.token, env);
}
async function puedeAcceder(identity, ruta, moduloId, usuarioId, tipo, env) {
  if (await admin(identity, env)) return true;
  if (!usuarioId || !rutaValida(usuarioId)) return false;
  if (tipo === 'foto') return ruta.startsWith(`fotos/${usuarioId}/`) && !!await firestoreGet(`usuarios/${usuarioId}`, identity.token, env);
  if (!moduloId || !rutaValida(moduloId)) return false;
  const asignacion = await firestoreGet(`asignaciones/${usuarioId}_${moduloId}`, identity.token, env);
  if (!asignacion || value(asignacion, 'habilitado')?.booleanValue !== true) return false;
  if (tipo !== 'certificado') return true;
  const historial = await firestoreGet(`historial/${usuarioId}_${moduloId}`, identity.token, env);
  return value(historial, 'estado')?.stringValue === 'COMPLETADO';
}
function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'TramarsaLMS-Gateway/1.0'
  };
}
async function errorGithub(response, accion) {
  const texto = await response.text().catch(() => '');
  let cuerpo = {};
  try { cuerpo = JSON.parse(texto); } catch (_) { /* respuesta no JSON */ }
  const detalle = (typeof cuerpo.message === 'string' ? cuerpo.message : texto).slice(0, 180);
  if (response.status === 401) return `GitHub rechazó el token al ${accion}. Actualiza el secreto GITHUB_TOKEN.`;
  if (response.status === 403) return `GitHub bloqueó la operación al ${accion}: ${detalle || 'verifica el permiso Contents.'}`;
  if (response.status === 404) return `GitHub no permitió acceder al repositorio o a la ruta al ${accion}.`;
  return `GitHub rechazó la operación al ${accion} (${response.status})${detalle ? `: ${detalle}` : '.'}`;
}
async function validarEscrituraGithub(env) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, {
    headers: githubHeaders(env)
  });
  if (!response.ok) {
    return { error: await errorGithub(response, 'validar el acceso al repositorio') };
  }
  const repositorio = await response.json();
  if (!repositorio.permissions?.push) {
    return { error: 'El token es válido, pero GitHub no le concede escritura sobre este repositorio. Revisa que el token tenga Contents: Read and write y que esté seleccionado grupotramarsa-lms-plantilla.' };
  }
  if (repositorio.default_branch !== (env.GITHUB_BRANCH || 'main')) {
    return { error: `El Worker apunta a la rama ${env.GITHUB_BRANCH || 'main'}, pero la rama principal del repositorio es ${repositorio.default_branch}.` };
  }
  return { repositorio };
}
function base64(buffer) {
  const bytes = new Uint8Array(buffer); let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
async function upload(request, identity, env) {
  const ruta = request.headers.get('X-Tramarsa-Path') || '';
  const tipo = request.headers.get('X-Tramarsa-Kind') || '';
  const moduloId = request.headers.get('X-Tramarsa-Module') || '';
  if (!rutaValida(ruta)) return json({ error: 'Ruta de archivo inválida.' }, 400);
  const permitido = tipo === 'foto'
    ? await puedeAcceder(identity, ruta, moduloId, ruta.split('/')[1], tipo, env)
    : await admin(identity, env);
  if (!permitido) return json({ error: 'No tienes permiso para cargar este archivo.' }, 403);
  const accesoGithub = await validarEscrituraGithub(env);
  if (accesoGithub.error) return json({ error: accesoGithub.error }, 502);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_FILE_BYTES) return json({ error: 'El archivo debe pesar entre 1 byte y 25 MB.' }, 413);
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(ruta).replace(/%2F/g, '/')}`;
  const response = await fetch(url, {
    method: 'PUT', headers: { ...githubHeaders(env), 'content-type': 'application/json' },
    body: JSON.stringify({ message: request.headers.get('X-Tramarsa-Message') || 'Actualiza archivo LMS', content: base64(body), branch: env.GITHUB_BRANCH || 'main' })
  });
  if (!response.ok) return json({ error: await errorGithub(response, 'cargar el archivo') }, 502);
  return json({ ruta });
}
async function download(url, identity, env) {
  const ruta = url.searchParams.get('ruta') || '';
  const moduloId = url.searchParams.get('moduloId') || '';
  const usuarioId = url.searchParams.get('usuarioId') || '';
  const tipo = url.searchParams.get('tipo') || 'archivo';
  if (!rutaValida(ruta)) return json({ error: 'Ruta de archivo inválida.' }, 400);
  if (!await puedeAcceder(identity, ruta, moduloId, usuarioId, tipo, env)) return json({ error: 'No tienes permiso para descargar este archivo.' }, 403);
  // La API Contents con la representación raw aplica el token también en
  // repositorios privados. raw.githubusercontent.com puede ignorarlo en
  // determinados redirects y dejar el reproductor sin el ZIP.
  const api = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(ruta).replace(/%2F/g, '/')}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`;
  const response = await fetch(api, {
    headers: { ...githubHeaders(env), Accept: 'application/vnd.github.raw+json' }
  });
  if (!response.ok) return json({ error: await errorGithub(response, 'descargar el archivo') }, 502);
  return new Response(response.body, { headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'private, no-store' } });
}
async function logoCorporativo(env) {
  const api = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/assets/logo_tram_white.png?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`;
  const response = await fetch(api, {
    headers: { ...githubHeaders(env), Accept: 'application/vnd.github.raw+json' }
  });
  if (!response.ok) return new Response('Logo no disponible.', { status: 404 });
  return new Response(response.body, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400'
    }
  });
}
async function remove(url, identity, env) {
  if (!await admin(identity, env)) return json({ error: 'No tienes permiso para eliminar este archivo.' }, 403);
  const ruta = url.searchParams.get('ruta') || '';
  if (!rutaValida(ruta)) return json({ error: 'Ruta de archivo inválida.' }, 400);
  const api = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(ruta).replace(/%2F/g, '/')}`;
  const previo = await fetch(`${api}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`, { headers: githubHeaders(env) });
  if (previo.status === 404) return new Response(null, { status: 204 });
  if (!previo.ok) return json({ error: await errorGithub(previo, 'localizar el archivo') }, 502);
  const contenido = await previo.json();
  const eliminado = await fetch(api, {
    method: 'DELETE', headers: { ...githubHeaders(env), 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Elimina archivo huérfano del LMS', sha: contenido.sha, branch: env.GITHUB_BRANCH || 'main' })
  });
  if (!eliminado.ok) return json({ error: await errorGithub(eliminado, 'eliminar el archivo') }, 502);
  return new Response(null, { status: 204 });
}

function dniValido(dni) {
  return typeof dni === 'string' && /^\d{8}$/.test(dni);
}
function base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function pemBytes(pem) {
  const contenido = String(pem || '').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  return base64UrlBytes(contenido).buffer;
}
async function tokenCuentaServicio(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error('La credencial de correo seguro no estÃ¡ configurada.');
  const cuenta = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const ahora = Math.floor(Date.now() / 1000);
  const encabezado = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const carga = base64Url(JSON.stringify({
    iss: cuenta.client_email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit',
    aud: cuenta.token_uri || 'https://oauth2.googleapis.com/token',
    iat: ahora,
    exp: ahora + 3600
  }));
  const datos = `${encabezado}.${carga}`;
  const clave = await crypto.subtle.importKey('pkcs8', pemBytes(cuenta.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', clave, new TextEncoder().encode(datos));
  const respuesta = await fetch(cuenta.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${datos}.${base64(new Uint8Array(firma))}`.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    })
  });
  if (!respuesta.ok) throw new Error('No se pudo autorizar el correo de recuperaciÃ³n.');
  const resultado = await respuesta.json();
  if (!resultado.access_token) throw new Error('No se obtuvo autorizaciÃ³n para el correo de recuperaciÃ³n.');
  return resultado.access_token;
}
async function enlaceResetSeguro(correo, env) {
  const token = await tokenCuentaServicio(env);
  const respuesta = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Goog-User-Project': env.FIREBASE_PROJECT_ID,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      requestType: 'PASSWORD_RESET',
      email: correo,
      returnOobLink: true,
      targetProjectId: env.FIREBASE_PROJECT_ID
    })
  });
  if (!respuesta.ok) throw new Error('No se pudo generar el enlace de recuperaciÃ³n.');
  const resultado = await respuesta.json();
  if (!resultado.oobLink) throw new Error('Firebase no devolviÃ³ el enlace de recuperaciÃ³n.');
  return resultado.oobLink;
}
function plantillaRecuperacion(enlace, env) {
  const logo = `${(env.PUBLIC_GATEWAY_URL || 'https://tramarsa-lms-gateway.diego906p.workers.dev').replace(/\/$/, '')}/v1/brand/logo?v=2`;
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef3f9;font-family:Arial,Helvetica,sans-serif;color:#17233c;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef3f9;padding:32px 12px;"><tr><td align="center">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(19,47,88,.14);">
      <tr><td style="background:#073a8c;padding:28px 42px 26px;">
        <table role="presentation" width="100%"><tr><td><img src="${logo}" width="182" alt="Grupo Tramarsa" style="display:block;width:182px;height:auto;border:0;outline:none;"></td><td align="right" style="color:#b8d7ff;font-size:12px;font-weight:700;letter-spacing:.7px;">LMS</td></tr></table>
      </td></tr>
      <tr><td style="padding:42px 42px 16px;">
        <div style="width:46px;height:46px;border-radius:12px;background:#e6f1ff;color:#0754c7;font-size:28px;line-height:46px;text-align:center;">&#128274;</div>
        <h1 style="margin:22px 0 14px;font-size:27px;line-height:34px;color:#102c63;">Restablece tu contrase&ntilde;a</h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:25px;color:#51627d;">Recibimos una solicitud para actualizar la contrase&ntilde;a de tu cuenta en <strong>TRAMARSA LMS</strong>.</p>
        <p style="margin:0 0 30px;font-size:16px;line-height:25px;color:#51627d;">Para continuar, utiliza el siguiente enlace seguro:</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:9px;background:#0a5bea;"><a href="${enlace}" style="display:inline-block;padding:15px 24px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;">Crear nueva contrase&ntilde;a</a></td></tr></table>
        <p style="margin:32px 0 0;padding:18px 0 0;border-top:1px solid #dfe6ef;font-size:13px;line-height:20px;color:#74839b;">Si no solicitaste este cambio, ignora este correo. Tu contrase&ntilde;a actual no se modificar&aacute;.</p>
      </td></tr>
      <tr><td style="padding:20px 42px 28px;background:#f7f9fc;color:#71809a;font-size:12px;line-height:18px;">Este mensaje fue enviado por TRAMARSA LMS para proteger el acceso a la plataforma.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
async function enviarCorreoCorporativo(correo, enlace, env) {
  if (!env.RESEND_API_KEY) throw new Error('El servicio de correo corporativo no estÃ¡ configurado.');
  const respuesta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'TRAMARSA LMS <onboarding@resend.dev>',
      to: [correo],
      subject: 'Restablece tu contrase\u00f1a | TRAMARSA LMS',
      html: plantillaRecuperacion(enlace, env)
    })
  });
  if (!respuesta.ok) throw new Error('Resend no pudo entregar el correo corporativo.');
}
async function leerJson(request) {
  try { return await request.json(); }
  catch (_) { throw new Error('La solicitud no contiene JSON válido.'); }
}
async function resolverLoginPorDni(request, env) {
  if (!origenPermitido(request, env)) return json({ error: 'Origen no permitido.' }, 403);
  const { dni, password } = await leerJson(request);
  if (!dniValido(dni)) return json({ error: 'Ingresa un DNI válido de 8 dígitos.' }, 400);
  if (typeof password !== 'string' || !password) return json({ error: 'Ingresa tu contraseña.' }, 400);
  const registro = await env.LMS_LOGIN_INDEX.get(`dni:${dni}`, 'json');
  if (!registro || typeof registro.correo !== 'string') return json({ error: 'El DNI no está registrado.' }, 404);
  const firebase = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registro.correo, password, returnSecureToken: true })
  });
  if (!firebase.ok) return json({ error: 'La contraseña es incorrecta.' }, 401);
  return json({ correo: registro.correo });
}
async function solicitarResetPorDni(request, env) {
  if (!origenPermitido(request, env)) return json({ error: 'Origen no permitido.' }, 403);
  const { dni } = await leerJson(request);
  if (!dniValido(dni)) return json({ error: 'Ingresa un DNI válido de 8 dígitos.' }, 400);
  const registro = await env.LMS_LOGIN_INDEX.get(`dni:${dni}`, 'json');
  // La respuesta es intencionalmente uniforme: nunca revela si el DNI o
  // el correo interno existen, pero conserva el flujo original por DNI.
  if (registro && typeof registro.correo === 'string') {
    try {
      const enlace = await enlaceResetSeguro(registro.correo, env);
      await enviarCorreoCorporativo(registro.correo, enlace, env);
    } catch (error) {
      // Resend solo entrega con onboarding@resend.dev al correo del titular
      // de la cuenta. El correo nativo conserva la recuperaciÃ³n operativa
      // hasta que se verifique un dominio corporativo.
      console.error('No se enviÃ³ el correo corporativo:', error.message);
      return json({ error: 'No se pudo enviar el correo corporativo de recuperacion. Revisa la configuracion de Resend.' }, 502);
    }
  }
  return new Response(null, { status: 204 });
}
async function actualizarIndiceLogin(request, identity, env) {
  if (!await admin(identity, env)) return json({ error: 'No tienes permiso para administrar accesos.' }, 403);
  const { dni, correo } = await leerJson(request);
  if (!dniValido(dni) || typeof correo !== 'string' || !correo.includes('@')) {
    return json({ error: 'DNI o correo inválido.' }, 400);
  }
  await env.LMS_LOGIN_INDEX.put(`dni:${dni}`, JSON.stringify({ correo: correo.trim().toLowerCase() }));
  return new Response(null, { status: 204 });
}
async function eliminarIndiceLogin(url, identity, env) {
  if (!await admin(identity, env)) return json({ error: 'No tienes permiso para administrar accesos.' }, 403);
  const dni = url.searchParams.get('dni') || '';
  if (!dniValido(dni)) return json({ error: 'DNI inválido.' }, 400);
  await env.LMS_LOGIN_INDEX.delete(`dni:${dni}`);
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...headers, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Tramarsa-Path, X-Tramarsa-Kind, X-Tramarsa-Module, X-Tramarsa-Message', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' } });
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/login') {
        const response = await resolverLoginPorDni(request, env);
        const responseHeaders = new Headers(response.headers); Object.entries(headers).forEach(([k, v]) => responseHeaders.set(k, v));
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      }
      if (request.method === 'POST' && url.pathname === '/v1/password-reset') {
        const response = await solicitarResetPorDni(request, env);
        const responseHeaders = new Headers(response.headers); Object.entries(headers).forEach(([k, v]) => responseHeaders.set(k, v));
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      }
      if (request.method === 'GET' && url.pathname === '/v1/brand/logo') return logoCorporativo(env);
      const identity = await verifyFirebaseToken(request, env);
      const response = request.method === 'POST' && url.pathname === '/v1/assets' ? await upload(request, identity, env)
        : request.method === 'GET' && url.pathname === '/v1/assets' ? await download(url, identity, env)
        : request.method === 'DELETE' && url.pathname === '/v1/assets' ? await remove(url, identity, env)
        : request.method === 'POST' && url.pathname === '/v1/login-index' ? await actualizarIndiceLogin(request, identity, env)
        : request.method === 'DELETE' && url.pathname === '/v1/login-index' ? await eliminarIndiceLogin(url, identity, env)
        : json({ error: 'Ruta no encontrada.' }, 404);
      const responseHeaders = new Headers(response.headers); Object.entries(headers).forEach(([k, v]) => responseHeaders.set(k, v));
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      return json({ error: error.message || 'No autorizado.' }, 401, headers);
    }
  }
};
