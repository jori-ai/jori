#!/usr/bin/env python3
# mkt-ga4-lp-pull.py <ga4-config.json> <YYYY-MM-DD>
# Emits one JSON line: {date, lp_views, lp_views_by_path, download_clicks, download_clicks_by_path}
# for the app's paid landing-page funnel (pages under /lp/). Used by
# mkt-conversion-collect, which runs it with marketing.json `venv` (a virtualenv
# with google-api-python-client + google-auth).
import sys, json, warnings
warnings.filterwarnings("ignore")
from google.oauth2 import service_account
from googleapiclient.discovery import build

cfg = json.load(open(sys.argv[1]))
date = sys.argv[2]
creds = service_account.Credentials.from_service_account_file(
    cfg["sa_key_path"], scopes=["https://www.googleapis.com/auth/analytics.readonly"])
data = build("analyticsdata", "v1beta", credentials=creds, cache_discovery=False)
prop = "properties/" + str(cfg["property_id"])
dr = [{"startDate": date, "endDate": date}]

def run(body):
    return data.properties().runReport(property=prop, body=body).execute()

lp = run({"dateRanges": dr, "dimensions": [{"name": "pagePath"}],
          "metrics": [{"name": "screenPageViews"}],
          "dimensionFilter": {"filter": {"fieldName": "pagePath",
              "stringFilter": {"matchType": "CONTAINS", "value": "/lp/"}}}})
lp_by_path, lp_total = {}, 0
for r in lp.get("rows", []):
    p = r["dimensionValues"][0]["value"]; v = int(r["metricValues"][0]["value"])
    lp_by_path[p] = v; lp_total += v

# Break out app_download_click by the page it fired on, mirroring lp_views_by_path
# (built-in pagePath dimension = page_location at event time; works without a
# registered custom dimension). The eventName EXACT filter keeps it to store CTAs.
dc = run({"dateRanges": dr, "dimensions": [{"name": "pagePath"}],
          "metrics": [{"name": "eventCount"}],
          "dimensionFilter": {"filter": {"fieldName": "eventName",
              "stringFilter": {"matchType": "EXACT", "value": "app_download_click"}}}})
dc_by_path, dc_total = {}, 0
for r in dc.get("rows", []):
    p = r["dimensionValues"][0]["value"]; v = int(r["metricValues"][0]["value"])
    dc_by_path[p] = dc_by_path.get(p, 0) + v; dc_total += v

print(json.dumps({"date": date, "lp_views": lp_total,
                  "lp_views_by_path": lp_by_path, "download_clicks": dc_total,
                  "download_clicks_by_path": dc_by_path}))
