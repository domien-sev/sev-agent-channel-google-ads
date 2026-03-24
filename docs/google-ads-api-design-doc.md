# Google Ads API — Design Document

**Tool Name:** sev-agent-google-ads
**Company:** Shopping Event VIP (shoppingeventvip.be)
**Manager Account ID:** 581-929-2007
**Customer Account ID:** 626-733-7247
**Access Level Requested:** Basic Access
**Date:** March 2026

---

## 1. Overview

**sev-agent-google-ads** is an internal tool built by Shopping Event VIP, a Belgian fashion e-commerce outlet, to assist our marketing team in managing Google Ads campaigns for our own store. The tool is not customer-facing and is not offered as a product or service to third parties.

The tool provides a structured interface for campaign research, creation, keyword management, performance reporting, and optimization recommendations. It operates exclusively on our own Google Ads account (Customer ID 626-733-7247) under our manager account (581-929-2007).

**Users:** Internal marketing and operations team members at Shopping Event VIP. There are no external users.

**Purpose:** Reduce manual effort in campaign management, improve consistency in campaign setup, and surface actionable performance insights through automated reporting and data synchronization with our internal dashboards.

---

## 2. Architecture

### System Components

- **sev-agent-google-ads** — A Node.js/TypeScript application deployed as a Docker container on a private Hetzner server managed via Coolify.
- **Google Ads API v23** — REST endpoints accessed over HTTPS.
- **Directus** — Internal data hub where keyword data, search terms, and performance metrics are synced for dashboard visualization.

### Authentication Flow

The tool uses the **OAuth2 web application flow**:

1. A one-time authorization is performed by an admin to obtain an authorization code.
2. The authorization code is exchanged for access and refresh tokens.
3. The refresh token is stored in an encrypted environment variable on the private server.
4. At runtime, the tool uses the refresh token to obtain short-lived access tokens as needed.
5. All API requests are made over HTTPS with the access token in the `Authorization` header and the developer token in the `developer-token` header.

### Request Flow

```
Internal Team --> sev-agent-google-ads --> Google Ads API v23 (REST/HTTPS)
                        |
                        +--> Directus (internal database sync)
```

All requests to the Google Ads API are made sequentially from a single application instance. There are no parallel bulk operations.

---

## 3. Features and API Usage

### 3.1 Account Research

Reads campaign structure and performance data using GAQL (Google Ads Query Language) queries.

- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:search`
- **Resources queried:** `campaign`, `ad_group`, `ad_group_criterion` (keywords), `keyword_view`
- **Access type:** Read-only
- **Purpose:** Understand current account structure, identify top-performing campaigns and keywords, and inform optimization decisions.

### 3.2 Campaign Creation

Creates new campaign structures in a paused state for human review before activation.

- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:mutate`
- **Resources mutated:**
  - `campaignBudget` — Set daily budget for new campaigns
  - `campaign` — Create campaigns (Search, Shopping, Performance Max, Display, YouTube) with status **PAUSED**
  - `adGroup` — Create ad groups within campaigns
  - `adGroupCriterion` — Add keyword targeting to ad groups
  - `adGroupAd` — Create ad copy (responsive search ads, responsive display ads)
  - `assetGroup` — Create asset groups for Performance Max campaigns
- **Access type:** Write (create only, all entities created as PAUSED)

### 3.3 Keyword Management

Reads keyword performance and search term reports; adds negative keywords to filter irrelevant traffic.

- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:search` (read)
- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:mutate` (write)
- **Resources queried:** `keyword_view`, `search_term_view`
- **Resources mutated:** `campaignCriterion` (negative keywords only)
- **Purpose:** Identify high-performing and wasteful search terms, add negative keywords to reduce wasted spend.

### 3.4 Audience Management

Reads existing audiences and creates custom audiences for targeting.

- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:search` (read)
- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:mutate` (write)
- **Resources queried:** `user_list`, `custom_audience`
- **Resources mutated:** `customAudience` (create only)
- **Purpose:** Build targeted audiences based on product interest signals for Shopping and Performance Max campaigns.

### 3.5 Performance Reporting

Retrieves campaign, ad group, and keyword-level metrics for analysis and dashboard display.

- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:search`
- **Resources queried:** `campaign`, `ad_group`, `ad_group_criterion`, `keyword_view`
- **Metrics accessed:** `impressions`, `clicks`, `cost_micros`, `conversions`, `conversions_value`, `ctr`, `average_cpc`, `average_cpm`
- **Segments used:** `date`, `device`
- **Access type:** Read-only

### 3.6 Optimization Recommendations

Analyzes performance data and generates suggestions such as budget reallocation between campaigns or keyword bid adjustments. **No automated changes are applied.** All recommendations are presented to the marketing team for manual review and approval.

- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:search`
- **Resources queried:** `campaign`, `ad_group`, `keyword_view` (metrics analysis)
- **Access type:** Read-only (analysis only, no mutations)

### 3.7 Directus Data Sync

Copies keyword text, search term data, quality scores, and performance metrics from Google Ads to our internal Directus database. This powers internal dashboards for the marketing team.

- **Endpoint:** `POST /v23/customers/{customerId}/googleAds:search`
- **Resources queried:** `keyword_view`, `search_term_view`, `campaign`, `ad_group`
- **Access type:** Read-only (data is written to Directus, not back to Google Ads)

---

## 4. Rate Limiting

The tool handles Google Ads API rate limits as follows:

- All API requests are made **sequentially**. The tool does not execute parallel or concurrent bulk operations.
- A single application instance makes all requests, ensuring predictable load.
- If a rate limit error (HTTP 429 or `RESOURCE_EXHAUSTED`) is received, the tool waits with exponential backoff before retrying.
- Daily operations are limited to periodic syncs and on-demand campaign management tasks initiated by team members.
- The tool does not perform continuous polling or high-frequency automated queries.

---

## 5. Data Handling

### Data Stored Internally

The following data is synced from Google Ads to our internal Directus database:

- Keyword text and match types
- Search term text
- Quality scores and keyword status
- Campaign and ad group names and IDs
- Performance metrics (impressions, clicks, cost, conversions, CTR, CPC)
- Audience names and types

### Data NOT Stored

- **No personally identifiable information (PII)** is collected or stored. The tool does not access or process end-user data, customer lists with PII, or any user-level data.
- Google Ads API credentials (tokens) are never written to the database.

### Data Retention

Synced performance data is retained in our internal database for historical trend analysis. No Google Ads data is shared with third parties.

---

## 6. Security

- **OAuth2 credentials** (client ID, client secret, refresh token, developer token) are stored as **encrypted environment variables** on a private server, managed through Coolify's secret management.
- **Refresh tokens are never logged** in application logs or error reports.
- All communication with the Google Ads API is over **HTTPS** (TLS 1.2+).
- The application runs on a **private server** (Hetzner) that is not publicly accessible except through a reverse proxy with authentication.
- Access to the tool is restricted to authorized internal team members via authentication on the server.
- Source code is hosted in a **private GitHub repository** with access limited to the development team.

---

## 7. Human Oversight

The tool is designed with mandatory human oversight at every critical decision point:

- **All campaigns are created with status PAUSED.** No campaign, ad group, or ad is ever activated automatically. A team member must manually review and enable each campaign in the Google Ads UI or through an explicit approval action.
- **No automated budget changes.** The tool may suggest budget reallocations based on performance data, but it never applies budget changes without explicit human approval.
- **No automated bid changes.** Bid adjustments are suggested, not applied.
- **Negative keywords** are the only write operation that may be applied in a semi-automated fashion, and these are logged and reviewable.
- The internal team reviews all optimization recommendations before any changes are made to the live account.

---

*This document describes the design and usage of sev-agent-google-ads for the purpose of Google Ads API Basic Access application review. The tool is used exclusively for managing Shopping Event VIP's own Google Ads account.*
