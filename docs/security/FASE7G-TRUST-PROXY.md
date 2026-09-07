# FASE 7G — Trust Proxy + Rate Limiting Hardening

## 1. Estado original (auditado, commit `92bdb50`)

- `src/app.ts`: `const app = Fastify({ logger: true });` — **sin `trustProxy`**.
- `@fastify/rate-limit` registrado `global: false`, con `keyGenerator: (req) => req.ip` — el **único** lugar de todo `src/` donde se lee `req.ip`. Ningún parseo manual de `X-Forwarded-For` en ningún otro sitio.
- Rutas con rate limit propio (todas usan la misma `keyGenerator` global):

| Ruta | max | window | Auth principal |
|---|---|---|---|
| `POST /api/leads` | `LEADS_RATE_LIMIT_MAX` (default 20) | `LEADS_RATE_LIMIT_WINDOW_MS` (default 60s) | ninguna (pública, browser) |
| `GET /api/availability` | 60 | 60s | ninguna (pública) |
| `POST /api/appointments` | 30 | 60s | ninguna (pública) |
| `POST /webhooks/whatsapp` | 300 | 60s | HMAC (`X-Hub-Signature-256` + `META_APP_SECRET`) |
| `POST /internal/reminders/run` | 20 | 60s | secreto (`REMINDER_RUNNER_SECRET`) |
| `POST /internal/hubspot-sync/run` | 20 | 60s | secreto (`HUBSPOT_SYNC_RUNNER_SECRET`) |
| `POST /api/appointments/:id/mark-completed` | 20 | 60s | `ADMIN_API_TOKEN` |
| `POST /api/appointments/:id/mark-no-show` | 20 | 60s | `ADMIN_API_TOKEN` |
| `POST /api/leads/:id/recover-handoff` | 20 | 60s | `ADMIN_API_TOKEN` |

## 2. Riesgo — confirmado, no descartado

Sin `trustProxy`, `req.ip` de Fastify resuelve a `request.socket.remoteAddress` — el peer TCP directo, que detrás del proxy de Render es la propia IP interna del load balancer de Render, **constante para prácticamente todas las requests externas**. Verificado empíricamente con una instancia Fastify real (`tests/trust-proxy-fastify.test.ts`, caso "confirms the exact risk"): dos clientes reales distintos (IPs de X-Forwarded-For distintas) resuelven al **mismo** `req.ip`, y en un rate limit real de `max:1`, el segundo cliente recibe `429` por tráfico del primero.

## 3. Topología de Render — verificada en la medida posible, límites declarados explícitamente

Fuentes (ninguna es una especificación formal de cabeceras de Render; se citan como lo que son):
- Foro de feedback de Render, respuesta de un ingeniero de Render (Aseem Kishore / Anurag Goel): *"Render does not clear or reset any passed-in X-Forwarded-For header (it only appends to it)"* — https://feedback.render.com/features/p/send-the-correct-xforwardedfor
- Artículo propio de Render sobre protección DDoS: *"All inbound traffic to Render web services passes through Cloudflare's global network before reaching your application"* y *"traffic passes through Cloudflare and Render's load balancers"* — https://render.com/articles/how-render-handles-ddos-attacks
- Hilo de la comunidad de Render sobre cómo acceder a la IP del cliente — https://community.render.com/t/accessing-client-ips-in-a-node-express-app/36282

**Topología asumida (2 hops confiables delante del contenedor): cliente → borde de Cloudflare → load balancer de Render → nuestro contenedor.** El socket que ve nuestro proceso Node es el load balancer de Render (hop 0), nunca Cloudflare ni el cliente real.

**Declarado explícitamente, sin inventar:** no existe documentación formal de Render que fije el número exacto de hops ni el formato exacto en que reescribe `X-Forwarded-For` byte a byte. Por eso la configuración elegida (§5) **no depende de contar hops exactos** — depende de verificar que cada hop más allá del socket sea una IP publicada de Cloudflare, sea cual sea el número real de hops.

## 4. Hallazgo empírico crítico: `trustProxy` numérico es un no-op en esta versión exacta de Fastify

`fastify@5.12.1` (instalada; `package.json` pide `^5.2.1`), en `node_modules/fastify/lib/request.js`:

```js
if (typeof tp === 'number') {
  // Hop-count-only trust cannot validate the immediate peer. Fail closed so
  // direct clients cannot spoof X-Forwarded-* values by supplying enough hops.
  return function () { return false }
}
```

Verificado con una instancia Fastify real, no solo leyendo el código fuente: `trustProxy: 1` y `trustProxy: 2` producen **exactamente** el mismo `req.ip` que no tener `trustProxy` en absoluto (`tests/trust-proxy-fastify.test.ts`). Esto invalida la hipótesis de partida del propio brief ("evaluar `trustProxy: 1`") para esta base de código concreta — no es una opción funcional aquí, y se documenta como tal en vez de usarla a ciegas.

`trustProxy: true` fue también verificado como inseguro: `req.ip` termina siendo la entrada **más a la izquierda** de `X-Forwarded-For`, 100% controlada por el cliente.

## 5. Configuración elegida

Función personalizada (`src/domain/trusted-proxy.ts`, `trustedProxyFn`), siguiendo el contrato de `proxy-addr`/`@fastify/proxy-addr` `(addr, hopIndex) => boolean`:

- `hopIndex === 0` (el socket, load balancer de Render): **siempre confiado** — no es una decisión de seguridad, es un hecho: así llegó la conexión TCP, no hay cabecera que falsificar en esa capa.
- Cualquier hop posterior: confiado **solo** si su dirección cae dentro de los rangos IP publicados de Cloudflare (`https://www.cloudflare.com/ips-v4/` y `/ips-v6/`, embebidos en `CLOUDFLARE_IP_RANGES`).
- El recorrido se detiene en la primera dirección que no sea de Cloudflare — esa se convierte en `req.ip`.

Se descartó una lista CIDR pura (sin función) porque el propio hop 0 (el load balancer de Render) **no** es una IP de Cloudflare — una lista solo-Cloudflare rechazaría el hop 0 inmediatamente y volvería a colapsar en el bug original.

## 6. Propiedad de seguridad frente a spoofing (verificada)

Un cliente que antepone entradas fabricadas a `X-Forwarded-For` nunca puede cambiar `req.ip`: el recorrido siempre se detiene en la primera dirección no-Cloudflare, que — dada la topología confirmada — es siempre la entrada que Cloudflare realmente observó. Verificado con múltiples prefijos fabricados de distinta longitud/contenido, todos produciendo el mismo `req.ip` real (`tests/trust-proxy-fastify.test.ts`, "spoofing test").

## 7. Mantenimiento

Los rangos de Cloudflare cambian raramente pero cambian. Fuente de verdad: las dos URLs de arriba. No se consultan en tiempo real (una dependencia de red por request no se justifica para una lista que cambia en el orden de años). Re-verificar periódicamente.
