# Hostinger / baluartecapital.com.mx — security headers

**This repo is `baluarte-lead-engine` (the backend) only.** `baluartecapital.com.mx` and
`impuestos.html` live on Hostinger, in a separate repo/hosting account this session has no access
to — nothing here is applied automatically. The backend's own `onSend` security headers (see
`src/app.ts`) protect ONLY responses from this backend's API; they do nothing for the static site a
browser actually renders. Apply the snippet below directly in that site's `.htaccess` (Apache, which
is what Hostinger's shared hosting runs).

## 1. Where

The site's document root `.htaccess` (same directory as `impuestos.html` and `index.html`). If one
already exists (check for existing `RewriteEngine`/redirect rules), **add** the block below —
don't replace the file.

## 2. HTTPS redirect (confirm first, don't assume)

Hostinger's own panel usually offers a one-click "Force HTTPS" — check **Websites → \[site\] →
SSL** before adding a duplicate redirect here. If that panel toggle is already on, skip this block
(a second redirect layer is harmless but unnecessary). If not:

```apache
RewriteEngine On
RewriteCond %{HTTPS} off
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
```

## 3. Security headers

```apache
<IfModule mod_headers.c>
  # Confirmed via Hostinger's SSL panel toggle (or the redirect above) before enabling this --
  # do NOT add includeSubDomains/preload without first confirming EVERY subdomain on
  # baluartecapital.com.mx (including any subdomain not yet using HTTPS) can handle forced HTTPS.
  # A wrong includeSubDomains/preload is very hard to undo (preload list removal can take months).
  Header always set Strict-Transport-Security "max-age=15552000"

  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=()"

  # Prefer frame-ancestors (below, inside the CSP) over X-Frame-Options where both are supported --
  # sent together here only for older browsers that don't parse frame-ancestors.
  Header always set X-Frame-Options "SAMEORIGIN"

  # See §4 for the exact origin list and the unsafe-inline note.
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://js.hsforms.net https://js.hs-forms.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.hubapi.com https://forms.hsforms.com https://*.onrender.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self' https://forms.hsforms.com"
</IfModule>
```

## 4. About that CSP — read before enabling

The exact origin list above is a **starting proposal**, not a verified-against-live-site policy —
this session cannot load `impuestos.html` or the rest of the site to see every script/resource it
actually pulls in. Before enabling:

1. Open the site with browser DevTools → Console, with the CSP header active in **Report-Only**
   mode first:
   ```apache
   Header always set Content-Security-Policy-Report-Only "...(same policy)..."
   ```
   Load every page (home, `impuestos.html`, any other calculator/landing page) and watch the
   console for `Refused to load/execute...` violations — each one names the exact origin/directive
   to add.
2. Only switch `Content-Security-Policy-Report-Only` → `Content-Security-Policy` once a full
   click-through of the site produces zero violations.
3. **`'unsafe-inline'` on `script-src`**: included above because `impuestos.html`'s calculator
   logic (and HubSpot's Forms API embed) almost certainly relies on inline `<script>` blocks and/or
   inline event handlers today — this session has not audited that file's actual `<script>` tags.
   Document this as an **explicitly accepted, temporary gap** (per this task's own instruction),
   never remove it live without first migrating those scripts to external files. A real future
   migration path: move calculator logic to an external `.js` file the browser fetches from
   `'self'`, then drop `'unsafe-inline'` entirely (a `nonce-` or `sha256-` hash per inline script is
   the safer middle ground if externalizing everything isn't feasible at once).
4. `connect-src https://*.onrender.com` assumes the Lead Engine backend is called from
   `impuestos.html` at a `*.onrender.com` URL — replace with the actual backend origin if it's
   since moved to a custom domain.
5. HubSpot origins (`js.hsforms.net`, `forms.hsforms.com`, `api.hubapi.com`) are only needed while
   the parallel Forms-API dual-write (see `HubSpotFiscalSyncService`'s class doc comment) is still
   active — drop them from the CSP the same day that direct browser call is retired.

## 5. Directory listing / sensitive files

```apache
Options -Indexes

<FilesMatch "\.(env|log|sql|md|git)$">
  Require all denied
</FilesMatch>
```

## 6. Cache headers (optional, performance not security — include only if useful)

```apache
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/png "access plus 1 month"
  ExpiresByType image/jpeg "access plus 1 month"
  ExpiresByType text/css "access plus 1 week"
  ExpiresByType application/javascript "access plus 1 week"
</IfModule>
```

## Rollback

Every block above is additive to `.htaccess` — remove the block (or comment it out with `#`) to
fully revert. No database, DNS, or file outside `.htaccess` is touched by any of this.
