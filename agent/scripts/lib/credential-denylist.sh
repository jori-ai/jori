# credential-denylist.sh — source for jori_financial_domain <domain>: exit 0
# when <domain> (or a subdomain of it) is a money-movement site whose login the
# agent must never read or write headlessly (site-pass, dev-pass,
# logins-import-apple). Those sites stay manual (apple-pass, with approval).
#
# The list is a generic one of large banks, brokers, card issuers and payment
# apps — the same for every installation, not this user's accounts. An
# installation adds its own in agent/local/config/credentials.json
# {"deny_domains": ["examplebank.com"]}.
JORI_FINANCIAL_DENY=(
  bankofamerica.com chase.com wellsfargo.com usbank.com citi.com capitalone.com # kernel-guard-ok: generic money-movement denylist, not this user's accounts
  schwab.com fidelity.com vanguard.com etrade.com ibkr.com tdameritrade.com robinhood.com # kernel-guard-ok: generic money-movement denylist, not this user's accounts
  americanexpress.com amex.com paypal.com wise.com venmo.com coinbase.com kraken.com # kernel-guard-ok: generic money-movement denylist, not this user's accounts
)

jori_financial_domain() {
  local d x extra
  d="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [ -n "$d" ] || return 1
  extra=""
  if [ -n "${JORI_TOOLS:-}" ] && [ -f "$JORI_TOOLS/lib/instance.cjs" ]; then
    extra="$("${JORI_NODE:-node}" -e 'const c=require(process.argv[1]).localConfig("credentials",{deny_domains:[]});process.stdout.write((Array.isArray(c.deny_domains)?c.deny_domains:[]).filter((s)=>/^[A-Za-z0-9.-]+$/.test(s)).join(" "))' "$JORI_TOOLS/lib/instance.cjs" 2>/dev/null || true)"
  fi
  for x in "${JORI_FINANCIAL_DENY[@]}" $extra; do
    x="$(printf '%s' "$x" | tr '[:upper:]' '[:lower:]')"
    [[ "$d" == "$x" || "$d" == *".$x" ]] && return 0
  done
  return 1
}
