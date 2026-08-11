/*
 * El navegador no conoce ni necesita un token de GitHub. Los archivos privados
 * se intercambian exclusivamente con el Cloudflare Worker configurado abajo.
 */
export const WORKER_URL = 'https://tramarsa-lms-gateway.diego906p.workers.dev';

export function workerEstaConfigurado() {
  return /^https:\/\//i.test(WORKER_URL) && !WORKER_URL.includes('TU_CLOUDFLARE');
}
