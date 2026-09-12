#!/usr/bin/env bash
# Save the session's state back to object storage, then export the site as
# static files and publish it.
#
#   wp-save.sh            -> save + export + publish
#   wp-save.sh autosave   -> save state only (called every 5 minutes)
#   wp-save.sh true       -> save + export, but DO NOT publish (export_only)
set -euo pipefail

MODE="${1:-}"
WORK=/tmp/wp
OUT=/tmp/export
STAMP=$(date -u +%Y%m%d-%H%M%S)

# ---------------------------------------------------------------- save state
echo "::group::Save state"
mysqldump -uroot -proot --single-transaction --quick --default-character-set=utf8mb4 wp \
  | gzip -9 > /tmp/db.sql.gz
size=$(stat -c%s /tmp/db.sql.gz)
echo "  database dump: ${size} bytes"
# A dump that lost the posts table would otherwise overwrite a good backup.
# grep -c not -q: -q exits on the first match, gzip takes SIGPIPE, and
# pipefail then reports the whole pipeline as failed.
posts=$(zcat /tmp/db.sql.gz | grep -cE "CREATE TABLE .[A-Za-z0-9_]*posts." || true)
if [ "${posts:-0}" -lt 1 ]; then
  echo "REFUSING to save: the dump has no *_posts table"
  exit 1
fi
echo "  posts table present in dump: yes"
# Media goes to its own bucket with a real content type, because the Function
# hands R2's stored metadata straight to the browser.
r2put_media() {  # r2put_media <file> <key>
  # Extension first: `file` calls minified CSS "text/plain", and browsers refuse
  # a stylesheet served as text/plain under nosniff.
  local ct
  case "${1##*.}" in
    css) ct=text/css;; js) ct=application/javascript;; svg) ct=image/svg+xml;; webp) ct=image/webp;;
    png) ct=image/png;; jpg|jpeg) ct=image/jpeg;; gif) ct=image/gif;; mp4) ct=video/mp4;; webm) ct=video/webm;;
    pdf) ct=application/pdf;; woff) ct=font/woff;; woff2) ct=font/woff2;; json) ct=application/json;;
    *) ct=$(file --mime-type -b "$1" 2>/dev/null || echo application/octet-stream);;
  esac
  curl -sSf -m 900 -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: $ct"        --data-binary @"$1"        "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$MEDIA_BUCKET/objects/$2" -o /dev/null
}
r2put() {  # r2put <file> <key>
  curl -sSf -m 900 -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"     -H "Content-Type: application/gzip" --data-binary @"$1"     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$STATE_BUCKET/objects/$2"     -o /dev/null
}
r2put /tmp/db.sql.gz db-latest.sql.gz
r2put /tmp/db.sql.gz "history/${STAMP}-db.sql.gz"

tar czf /tmp/wp-content.tar.gz --exclude=wp-content/uploads -C "$WORK" \
  --exclude='wp-content/cache' --exclude='wp-content/upgrade' \
  --exclude='wp-content/upgrade-temp-backup' wp-content
r2put /tmp/wp-content.tar.gz wp-content.tar.gz
echo "  state saved"
echo "::endgroup::"

[ "$MODE" = "autosave" ] && { echo "autosave only - not exporting"; exit 0; }

# --------------------------------------------------------------- export site
echo "::group::Export static site"
rm -rf "$OUT"; mkdir -p "$OUT"

# The PHP server started in an earlier workflow step does NOT reliably survive
# into this one - each step gets its own session. Start our own if it is gone.
if ! curl -sf -o /dev/null -m 5 -H "Host: ${SITE_HOST}" http://127.0.0.1:8080/ ; then
  echo "  php server not answering - starting one for the export"
  cd "$WORK"
  PHP_CLI_SERVER_WORKERS=6 setsid nohup php -S 0.0.0.0:8080 -t "$WORK" > /tmp/php-export.log 2>&1 < /dev/null &
  for i in $(seq 1 20); do
    curl -sf -o /dev/null -m 3 -H "Host: ${SITE_HOST}" http://127.0.0.1:8080/ && break
    sleep 1
  done
  cd - >/dev/null
fi
code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 -H "Host: ${SITE_HOST}" http://127.0.0.1:8080/ || true)
echo "  php server responds: ${code}"
# Point the live hostname at this runner so the crawl produces real URLs.
grep -q " ${SITE_HOST}\$" /etc/hosts || echo "127.0.0.1 ${SITE_HOST}" | sudo tee -a /etc/hosts >/dev/null

# WordPress canonicalises every request to WP_HOME. While that is https, the
# crawler is 301'd to port 443 on this runner, where nothing listens, and every
# fetch fails with "Connection refused". Point WP at the http export URL for
# the duration of the crawl; the state was already saved above, and the runner
# is thrown away afterwards. Published URLs are rewritten back below.
# This site's menus/content hardcode absolute APEX URLs, so wget link-following
# finds nothing and rewriting them in the DB 500s the site. Serve at www:8080 (the
# config that renders 200) and drive the crawl from the Yoast sitemap instead.
sed -i "s#define('WP_HOME','https://${SITE_HOST}');#define('WP_HOME','http://${SITE_HOST}:8080');#" "$WORK/wp-config.php"
sed -i "s#define('WP_SITEURL','https://${SITE_HOST}');#define('WP_SITEURL','http://${SITE_HOST}:8080');#" "$WORK/wp-config.php"
pkill -f "php -S 0.0.0.0:8080" || true
sleep 2
cd "$WORK"
PHP_CLI_SERVER_WORKERS=6 setsid nohup php -S 0.0.0.0:8080 -t "$WORK" > /tmp/php-export.log 2>&1 < /dev/null &
cd - >/dev/null
BASE="http://${SITE_HOST}:8080"
for i in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$BASE/" || true)" = "200" ] && break; sleep 1
done
echo "  export URL responds: $(curl -s -o /dev/null -w '%{http_code}' -m 8 "$BASE/" || true) (200 expected)"

# Enumerate public URLs with wp-cli (reliable; the fresh runner's rewrite rules
# aren't flushed so Yoast's sitemap 404s and CPT permalinks are ugly). Flush first,
# then list posts + category terms. Runs on PHP 7.4 so plugins load without fataling.
WPCLI=/tmp/wp-cli.phar
[ -f "$WPCLI" ] || curl -fsSL -m 60 https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o "$WPCLI"
php "$WPCLI" --path="$WORK" --allow-root rewrite flush --hard >/dev/null 2>&1 || true
: > /tmp/urls
php "$WPCLI" --path="$WORK" --allow-root post list --post_type=page,post --post_status=publish --field=url >> /tmp/urls 2>/dev/null || true
for tax in category post_tag; do
  php "$WPCLI" --path="$WORK" --allow-root term list "$tax" --field=url >> /tmp/urls 2>/dev/null || true
done
# normalise host to the crawl base, drop ugly ?query URLs and dupes
sed -i -E "s#https?://[^/]+#${BASE}#" /tmp/urls
grep -v '?' /tmp/urls 2>/dev/null | sort -u > /tmp/urls.clean || true
mv /tmp/urls.clean /tmp/urls
echo "  URLs to fetch: $(wc -l < /tmp/urls)"

# homepage first (with its assets), then every sitemap URL with page requisites
wget --page-requisites --adjust-extension --convert-links --no-parent --restrict-file-names=windows      --no-verbose --execute robots=off --tries=2 --timeout=25      --reject-regex '(wp-admin|wp-login|xmlrpc|wp-json|/feed|/wp-content/uploads/)'      --directory-prefix "$OUT" --no-host-directories "$BASE/" >/dev/null 2>&1 || true
while read -r u; do
  [ -z "$u" ] && continue
  wget --page-requisites --adjust-extension --convert-links --no-parent --restrict-file-names=windows        --no-verbose --execute robots=off --tries=2 --timeout=25        --reject-regex '(wp-admin|wp-login|xmlrpc|wp-json|/feed|/wp-content/uploads/)'        --directory-prefix "$OUT" --no-host-directories "$u" >/dev/null 2>&1 || true
done < /tmp/urls

# The media library is served from R2 by the Function, so the crawl skipped it;
# the reference check is told the same so it neither flags nor "recovers" it.
EXTERNAL="--external-prefix=/wp-content/uploads/"

# The media library is served from R2 by the Function, so the crawl skipped it;
# the reference check is told the same so it neither flags nor "recovers" it.
EXTERNAL="--external-prefix=/wp-content/uploads/"



# Pages linked only as https://<apex>/... are a different host to wget, so the
# first pass silently misses them (trupack.ca links its contact page that way).
# Read the links back out of what we did fetch and pull anything still absent.
echo "  looking for pages the crawl missed"
apex="${SITE_HOST#www.}"
for round in 1 2; do
  grep -rhoE 'href="https?://(www\.)?'"${apex//./\.}"'/[^"#?]*"' "$OUT" --include='*.html' 2>/dev/null     | sed -E 's#^href="https?://[^/]+##; s#"$##' | sort -u > /tmp/paths || true
  added=0
  while read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      */wp-json/*|*/feed/*|*/wp-admin/*|*wp-content/*|*wp-includes/*) continue;;
      *.css|*.js|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.svg|*.ico|*.xml) continue;;
    esac
    target="$OUT${path%/}/index.html"
    [ "$path" = "/" ] && target="$OUT/index.html"
    if [ ! -f "$target" ]; then
      echo "    recovering: $path"
      wget --page-requisites --adjust-extension --convert-links --no-verbose            --execute robots=off --tries=2 --timeout=25            --directory-prefix "$OUT" --no-host-directories            "${BASE}${path}" >/dev/null 2>&1 || true
      added=$((added+1))
    fi
  done < /tmp/paths
  echo "    round ${round}: recovered ${added} page(s)"
  [ "$added" -eq 0 ] && break
done

# Pages nothing links to but that are live and may be bookmarked or indexed.
for path in /shop/; do
  if [ ! -f "$OUT${path}index.html" ]; then
    wget --page-requisites --adjust-extension --convert-links --no-verbose --execute robots=off --tries=2 --timeout=25          --reject-regex '(/wp-content/uploads/|\?)' --directory-prefix "$OUT" --no-host-directories          "${BASE}${path}" >/dev/null 2>&1 || true
    [ -f "$OUT${path}index.html" ] && echo "  fetched orphaned page ${path}" || echo "  WARNING: orphaned page ${path} not fetched"
  fi
done

# Runs AFTER recovery: the recovery crawls re-create the cursor artefact otherwise.
# Things the crawl still picks up that must not ship: ?p= shortlink duplicates,
# the author archive (exposes the admin username), and cursor files wget renamed.
find "$OUT" -maxdepth 1 -type f \( -name 'index.html?p=*' -o -name 'index.html%3Fp=*' -o -name 'index.html@p=*' \) -delete 2>/dev/null || true
rm -rf "$OUT/author"
find "$OUT" -type f -name '*.cur.html' -delete 2>/dev/null || true

# (contact + careers forms are rewritten after asset recovery, below)

pages=$(find "$OUT" -name '*.html' | wc -l)
echo "  exported ${pages} html pages, $(find "$OUT" -type f | wc -l) files total"
find "$OUT" -name '*.html' | sed "s#$OUT##" | sort | sed 's/^/    page: /'

# Guard 1: a broken export must never replace a working site. MIN_PAGES is a
# per-site floor - trupack.ca genuinely has only four pages, so a fixed 5 was
# wrong. Set it to just below the real page count for each site.
MIN_PAGES="${MIN_PAGES:-100}"
if [ "$pages" -lt "$MIN_PAGES" ]; then
  echo "REFUSING to publish: only ${pages} pages exported (floor ${MIN_PAGES})"
  exit 1
fi
# Guard 2: wget saves 404 pages under the asset's name when a resource is
# missing, and --convert-links then rewires the site to those stubs. The page
# count alone does not catch it.
# grep -q exits on its first match, the find upstream takes SIGPIPE, and under
# pipefail the whole condition reads as false - so this guard never fired.
stubs=$(find "$OUT" -type f \( -name '*.jpg.html' -o -name '*.png.html' -o -name '*.gif.html' \
        -o -name '*.css.html' -o -name '*.js.html' \) | head -5)
if [ -n "$stubs" ]; then
  echo "REFUSING to publish: the export contains 404 stubs named as assets"
  echo "$stubs"
  exit 1
fi

# The crawl records the runner's port; the published site must not.
grep -rl ":8080" "$OUT" --include='*.html' --include='*.css' --include='*.js' \
     > /tmp/hits8080 2>/dev/null || true
if [ -s /tmp/hits8080 ]; then
  xargs -r sed -i "s#http://${SITE_HOST}:8080#https://${SITE_HOST}#g; s#${SITE_HOST}:8080#${SITE_HOST}#g" < /tmp/hits8080
fi

# wget --adjust-extension saves "main.css?ver=9" on disk as "main.css%3Fver=9.css",
# and --convert-links then rewires pages to that encoded name. The FIRST page
# crawled keeps absolute URLs, so the homepage looks perfect while every
# recovered inner page silently loads no CSS at all. Put the references back to
# clean root-relative paths, and drop the duplicate mangled files.
# -type f, and [?] not ?, because ? is a glob wildcard in find - '*?*'
# matches every name there is, directories included.
find "$OUT" -depth -type f \( -name '*%3F*' -o -name '*[?]*' \) -print0 2>/dev/null > /tmp/mangled || true
if [ -s /tmp/mangled ]; then
  while IFS= read -r -d '' f; do
    t="${f%%'%3F'*}"; t="${t%%'?'*}"
    if [ -e "$t" ]; then rm -f "$f"; else mv -f "$f" "$t"; fi
  done < /tmp/mangled
  echo "  removed $(tr -dc '\0' < /tmp/mangled | wc -c) query-mangled duplicate file(s)"
fi
grep -rlZ -F "%3F" "$OUT" --include='*.html' --include='*.css' \
     > /tmp/hitsq 2>/dev/null || true
grep -rlZ -E "(href|src)=[\"']((\.\./)+|)wp-(content|includes)/" "$OUT" \
     --include='*.html' >> /tmp/hitsq 2>/dev/null || true
if [ -s /tmp/hitsq ]; then
  # In a heredoc nothing needs shell escaping, which this expression is full of.
  cat > /tmp/unmangle.sed <<'SED'
s#(href|src)=(.)(\.\./)*(wp-(content|includes)/)#\1=\2/\4#g
s#%3F[^'")]*##g
SED
  xargs -0 -r sed -i -E -f /tmp/unmangle.sed < /tmp/hitsq
  left=$({ grep -rhoF "%3F" "$OUT" --include='*.html' 2>/dev/null || true; } | wc -l)
  echo "  query-mangled asset references repaired; remaining: ${left}"
fi
# wget --restrict-file-names=windows bakes cache-busting queries ("?t=..&ver=..") into
# asset refs as "@t=..&amp;ver=..". Strip back to the clean name across all html so the
# recovery step can copy the real file (e.g. ckeditor.js) from the WP tree.
find "$OUT" -name '*.html' -print0 2>/dev/null | xargs -0 -r sed -i -E -f "$(dirname "$0")/unmangle-query.sed" || true

# Normalise internal links to SITE_HOST. The content links to the bare apex
# more often than to www, and a zone apex cannot be a CNAME - so those links
# would route through the old server on every click today, and break entirely
# once it is retired. Only www can point at Pages.
apex="${SITE_HOST#www.}"
if [ "$apex" != "$SITE_HOST" ]; then
  # Fixed-string grep, and xargs -0, because upload filenames can contain
  # spaces and the host contains dots that a regex would treat as wildcards.
  for scheme in http https; do
    grep -rlZ -F "${scheme}://${apex}/" "$OUT" \
         --include='*.html' --include='*.css' --include='*.js' --include='*.xml' \
         > /tmp/hits 2>/dev/null || true
    # A grep that matches nothing exits 1, and under pipefail that would kill
    # the whole publish silently - so collect first, then act.
    if [ -s /tmp/hits ]; then
      xargs -0 -r sed -i "s|${scheme}://${apex}/|https://${SITE_HOST}/|g" < /tmp/hits
    fi
  done
  # Success here means zero matches, and a grep that matches nothing exits 1.
  left=$({ grep -rhoF "//${apex}/" "$OUT" --include='*.html' 2>/dev/null || true; } | wc -l)
  echo "  internal links normalised to ${SITE_HOST}; apex references left: ${left}"
fi

# wget crawls the PHP built-in server concurrently and it refuses connections
# under burst - the log says "Connection refused" and a few assets are simply
# absent, with nothing else to show for it. They are ordinary files sitting in
# the WordPress tree, so copy them across rather than trusting another HTTP round.
python3 "$(dirname "$0")/check-assets.py" "$OUT" "$SITE_HOST" --list "$EXTERNAL" > /tmp/missing.txt || true
if [ -s /tmp/missing.txt ]; then
  recovered=0; absent=0
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    src="$WORK/${rel#/}"
    if [ -f "$src" ]; then
      mkdir -p "$OUT$(dirname "$rel")"
      cp -f "$src" "$OUT$rel"
      recovered=$((recovered+1))
    else
      absent=$((absent+1))
      echo "    not in the WordPress tree either: $rel"
    fi
  done < /tmp/missing.txt
  echo "  copied ${recovered} asset(s) the crawl missed; ${absent} genuinely absent"
fi

# WPForms (#1291 contact, #1358 careers application) submit over AJAX to
# /wp-json + admin-ajax.php, which do not exist statically - left alone they look
# fine and drop every enquiry/application. Rewrite them to plain POST forms that
# _worker.js delivers (contact -> /contact-send, application -> /apply-send with
# the resume stored in R2 and emailed to HR). Idempotent.
python3 "$(dirname "$0")/rewrite-form.py" "$OUT"

# Guard 3: every local asset a page references must exist in the export.
# Counting pages, diffing text, even counting stylesheet LINKS all called a
# broken export healthy - the links were there and pointed at nothing.
python3 "$(dirname "$0")/check-assets.py" "$OUT" "$SITE_HOST" "$EXTERNAL"

echo "::endgroup::"

if [ "$MODE" = "true" ]; then
  echo "export_only - not publishing"
  exit 0
fi

# -------------------------------------------------------------------- publish
echo "::group::Media added this session"
if [ -n "${MEDIA_BUCKET:-}" ] && [ -d "$WORK/wp-content/uploads" ]; then
  n=0
  while IFS= read -r -d '' f; do
    r2put_media "$f" "wp-content/uploads/${f#$WORK/wp-content/uploads/}" && n=$((n+1))
  done < <(find "$WORK/wp-content/uploads" -type f -newer /tmp/session-start              ! -path '*/wc-logs/*' ! -name '.htaccess' ! -name 'index.html' ! -name 'index.php' -print0 2>/dev/null)
  echo "  uploaded ${n} new media file(s) to ${MEDIA_BUCKET}"
fi
echo "::endgroup::"

echo "::group::Publish"
# The Pages Function that proxies /wp-admin to the editing tunnel must ship
# with the site: Pages has no Worker in front of it.
if [ -f public/_worker.js ]; then
  cp public/_worker.js "$OUT/_worker.js"
  echo "  included _worker.js ($(stat -c%s "$OUT/_worker.js") bytes)"
else
  echo "  WARNING: public/_worker.js missing - the admin proxy will not be deployed"
fi
npm install -g wrangler@3 >/dev/null 2>&1
npx wrangler pages deploy "$OUT" --project-name="$PAGES_PROJECT" --branch=main --commit-dirty=true
echo "::endgroup::"
