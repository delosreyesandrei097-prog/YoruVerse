# Source Plugin System - Architecture Documentation

## Overview

The Source Plugin System is the extensible extraction pipeline that allows the YoruVerse platform to import chapter data from external manga/manhwa websites. It follows a plugin architecture where each source website is supported by an independent plugin that implements a standardized interface.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Admin Dashboard                          │
│                   (Import Tab UI)                           │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │  Single   │  │    Bulk      │  │     Manual         │   │
│  │  Import   │  │    Import    │  │     Import         │   │
│  └─────┬────┘  └──────┬───────┘  └────────┬───────────┘   │
│        │               │                    │               │
│        └───────────────┼────────────────────┘               │
│                        │                                    │
│                        ▼                                    │
│              ┌──────────────────┐                           │
│              │   ImportTool     │  (import-tool.js)         │
│              │  - handleImport  │                           │
│              │  - handleBulk    │                           │
│              │  - showPreview   │                           │
│              │  - confirmImport │                           │
│              └────────┬────────┘                           │
└───────────────────────┼────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                 SourceRegistry                               │
│               (source-registry.js)                           │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Registration  │  Detection  │  Extraction  │ Events│    │
│  │  - register()  │  - findSource│  - extract() │  Evt  │    │
│  │  - unregister()│  - canHandle │  - normalize │  Sys  │    │
│  │  - validate    │  - getDomains│  - validate  │       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Registered Sources:                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ SourceTemplate│  │ SourceExample│  │  Custom...   │      │
│  │ (AsuraScans) │  │  (Example)   │  │              │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│               SourceConfig                                   │
│             (source-config.js)                               │
│                                                              │
│  - CORS Proxy URL (proxyUrl with {url} placeholder)         │
│  - Rate Limiting (per-domain, configurable ms)              │
│  - Custom Headers                                            │
│  - getProxiedUrl(url)                                        │
│  - waitForRateLimit(domain)                                   │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│          External Websites / CORS Proxies                    │
│                                                              │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │  Direct   │───▶│  Configured  │───▶│  AllOrigins  │       │
│  │  Fetch    │    │    Proxy     │    │   Fallback   │       │
│  └──────────┘    └──────────────┘    └──────────────┘       │
│    (fails if       (if proxyUrl        (api.allorigins       │
│     CORS blocks)    is configured)       .win/get)           │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Complete Extraction Flow

```
1. User pastes URL → Admin UI captures input
2. ImportTool.handleImport(url, seriesId)
3. SourceRegistry.canHandle(url) → checks if any source supports the URL
4. SourceRegistry.extract(url)
   a. URL validation (must be valid URL format)
   b. SourceConfig.waitForRateLimit(domain) → rate limiting
   c. SourceRegistry.findSource(url) → iterates sources, calls source.detect(url)
   d. source.extract(url) → delegates to matched source
      i.  source.fetchPage(url) → 3-strategy CORS proxy fallback
      ii. DOMParser.parseFromString(html) → parse fetched HTML
      iii. source.extractTitle(doc) → extract chapter title
      iv. source.extractChapterNumber(doc, url) → extract chapter number
      v.  source.extractImageUrls(doc) → extract image URLs
      vi. source.extractSeriesTitle(doc) → extract series name
      vii. source.validate(data) → validate extracted data
   e. SourceRegistry post-extraction validation (imageUrls required)
   f. Data normalization (ensures chapterTitle, extractedAt, etc.)
5. ImportTool.showPreview(data) → renders preview with thumbnails
6. User reviews preview and clicks "Confirm Import"
7. ImportTool.confirmImport()
   a. DB.getChapterByNumber(seriesId, chapterNumber) → check if exists
   b. If exists: DB.updateChapter() → update existing chapter
   c. If new: DB.addChapter() → create new chapter document
8. UI refreshes chapter list
```

### Bulk Import Flow

```
1. User pastes multiple URLs (one per line or comma-separated)
2. ImportTool.handleBulkImport()
3. Parse and validate URLs
4. Sequential processing loop:
   for each URL:
     a. SourceRegistry.extract(url) → extract data
     b. DB.getChapterByNumber() → check existence
     c. DB.addChapter() or DB.updateChapter() → save
     d. updateBulkProgress() → update progress bar
     e. addBulkResult() → add success/error entry
     f. SourceConfig.rateLimitMs delay between requests
5. Final status summary (X/Y imported, Z failed)
```

---

## File Structure

```
js/
├── source-config.js      # Global CORS proxy & rate limiting config
├── source-registry.js    # Plugin registry, detection, extraction
└── import-tool.js        # Import UI logic (single, bulk, manual)

sources/
├── source-template.js    # Template/example for Asura Scans
└── source-example.js      # Additional example source

pages/
└── admin.html            # Import tab UI with all import sections
```

---

## Source Plugin Interface

Every source plugin must implement the following interface:

### Required Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Display name of the source (e.g., "Asura Scans") |
| `domain` | `string` | Base domain for URL detection (e.g., "asurascans.com") |
| `patterns` | `RegExp[]` | URL regex patterns this source can handle |

### Required Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `detect(url)` | `boolean` | Check if this source can handle the given URL |
| `extract(url)` | `Promise<Object>` | Extract chapter data from the URL |
| `validate(data)` | `boolean` | Validate the extracted data structure |

### Recommended Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `fetchPage(url)` | `Promise<string>` | Fetch HTML with CORS proxy fallback |

### Extract Return Object

The `extract()` method must return a Promise resolving to:

```javascript
{
  chapterTitle: string | null,      // Chapter title text
  chapterNumber: number | null,    // Numeric chapter number (e.g., 1, 2.5)
  imageUrls: string[],             // Array of image URLs for chapter pages
  seriesTitle: string | null,      // Name of the series
  source: string,                  // Source plugin name (set automatically)
  sourceUrl: string                // Original extraction URL (set automatically)
}
```

---

## Registration System

### How Sources Are Registered

1. **Automatic Registration**: Source scripts are included in admin.html via `<script>` tags. Each source file creates a global variable (e.g., `window.SourceTemplate`) and the `SourceRegistry.init()` method (called on DOMContentLoaded) checks for known global variables and registers them.

2. **Manual Registration**: Any script loaded after source-registry.js can call:
   ```javascript
   SourceRegistry.register(mySourcePlugin);
   ```

3. **Script Loading Order** (in admin.html):
   ```html
   <script src="../js/source-config.js"></script>       <!-- Config first -->
   <script src="../sources/source-template.js"></script> <!-- Source plugins -->
   <script src="../sources/source-example.js"></script>  <!-- More plugins -->
   <script src="../js/source-registry.js"></script>     <!-- Registry last -->
   <script src="../js/import-tool.js"></script>          <!-- Import tool -->
   ```

### Registration Validation

When `register()` is called, the registry validates:
- The source is an object (not null/undefined)
- It has a `name` property (string)
- It has a `detect()` method (function)
- It has an `extract()` method (function)
- It has a `domain` property (warns if missing)
- It's not already registered (prevents duplicates)

---

## Detection System

### URL Detection Flow

When `findSource(url)` is called:

1. URL format validation (must parse as valid URL)
2. Iterate through registered sources **in registration order**
3. For each source, call `source.detect(url)`
4. Return the first source whose `detect()` returns `true`

### Detection Strategy

Each source's `detect()` method typically:
1. Parses the URL hostname
2. Checks if it contains the source's `domain`
3. Tests the URL against the source's `patterns` regex array
4. Returns `true` only if both domain and pattern match

**Important**: More specific sources should be registered before generic ones, since the first match wins.

---

## CORS Proxy System

### The Problem

Browsers enforce the Same-Origin Policy (CORS). When client-side JavaScript tries to `fetch()` a page from a different domain, the browser blocks the request unless the target server explicitly allows it via CORS headers. Most manga/manhwa sites do not send CORS headers, so direct fetching fails.

### Three-Strategy Fallback

The `fetchPage()` method in source-template.js tries three strategies in order:

1. **Direct Fetch** — Try `fetch(url, { mode: 'cors' })` directly. Works for sites that allow CORS or for same-origin requests. Fails silently and moves to next strategy.

2. **Configured Proxy** — If `SourceConfig.proxyUrl` is set, construct the proxied URL by replacing `{url}` placeholder with the encoded target URL. The proxy server fetches the target page server-side and returns it to the browser, bypassing CORS.

3. **AllOrigins Fallback** — Uses the free AllOrigins API (`https://api.allorigins.win/get?url=`) as a last resort. This is a public CORS proxy that returns page content in a JSON wrapper `{ contents: "..." }`.

### Configuring a Custom Proxy

```javascript
// Set a custom CORS proxy before source scripts load
SourceConfig.setProxyUrl('https://my-proxy.example.com/fetch?url={url}');

// Or set it directly
window.SourceConfig.proxyUrl = 'https://my-proxy.example.com/fetch?url={url}';
```

The `{url}` placeholder is replaced with `encodeURIComponent(targetUrl)` when fetching.

### Self-Hosted Proxy Example

A minimal CORS proxy in Node.js:

```javascript
const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.get('/fetch', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });
  
  try {
    const response = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await response.text();
    res.json({ contents: html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000);
// Set SourceConfig.proxyUrl = 'http://localhost:3000/fetch?url={url}'
```

---

## Rate Limiting

SourceConfig includes per-domain rate limiting to avoid overwhelming target servers:

- **Default Rate**: 1000ms (1 second) between requests to the same domain
- **Configuration**: `SourceConfig.rateLimitMs = 2000;` (set custom delay)
- **How It Works**: `waitForRateLimit(domain)` checks a per-domain timestamp map. If the last request to the domain was less than `rateLimitMs` ago, it waits the remaining time before resolving.
- **Bulk Import**: Between each URL in bulk import, the rate limit delay is applied automatically.

---

## Event System

SourceRegistry dispatches events that other code can listen to:

| Event | Detail | When Fired |
|-------|--------|------------|
| `registryReady` | `{ sourceCount }` | After `init()` completes |
| `sourceRegistered` | `{ source }` | When a new source is registered |
| `sourceUnregistered` | `{ source }` | When a source is removed |
| `extractionStarted` | `{ source, url }` | Before extraction begins |
| `extractionCompleted` | `{ source, url, data }` | After successful extraction |
| `extractionFailed` | `{ source, url, error }` | When extraction fails |

### Usage

```javascript
SourceRegistry.addEventListener('extractionCompleted', (detail) => {
  console.log(`Extracted ${detail.data.imageUrls.length} images from ${detail.url}`);
});

SourceRegistry.addEventListener('extractionFailed', (detail) => {
  console.error(`Failed to extract from ${detail.url}: ${detail.error.message}`);
});
```

---

## Creating a New Source Plugin

### Step-by-Step Guide

1. **Copy the template**:
   ```bash
   cp sources/source-template.js sources/source-mysite.js
   ```

2. **Update metadata**:
   ```javascript
   const SourceMySite = {
     name: 'My Manga Site',
     domain: 'mymangasite.com',
     patterns: [
       /mymangasite\.com\/read\/[^/]+\/chapter-\d+/
     ],
     // ...
   };
   window.SourceMySite = SourceMySite;
   ```

3. **Customize detection**: Update `detect()` to match your site's URL structure.

4. **Customize extractors**: Update the selector arrays in `extractTitle()`, `extractChapterNumber()`, `extractImageUrls()`, and `extractSeriesTitle()` to match the HTML structure of the target site.

5. **Add the script** to admin.html:
   ```html
   <script src="../sources/source-mysite.js"></script>
   ```

6. **Register in SourceRegistry.init()** (in source-registry.js):
   ```javascript
   if (window.SourceMySite) {
     this.register(window.SourceMySite);
   }
   ```

### Debugging Tips

- Use browser DevTools to inspect the HTML structure of the target site
- Test `fetchPage()` separately to verify CORS proxy is working
- Check the browser console for `[SourceRegistry]` prefixed log messages
- Use the `extractionFailed` event to capture detailed error info
- Most issues are caused by: (1) CORS blocking, (2) dynamically-loaded images not in initial HTML, (3) site structure changes breaking selectors

---

## Admin Dashboard Integration

### Import Tab Sections

The Import tab in the Admin Dashboard has four sections:

1. **Single Import** — Paste one URL, select a series, extract and preview before confirming
2. **Bulk Import** — Paste multiple URLs (one per line), all assigned to the same series, processed sequentially with progress bar and results list
3. **Supported Sources** — Automatically populated list of registered source plugins with their names and domains
4. **Manual Import** — Enter chapter data directly (series, chapter number, title, image URLs) without extraction

### Adding New UI Elements

When adding new source-related features to the admin dashboard:

1. Add HTML elements in the Import tab section of `pages/admin.html`
2. Wire event handlers in the inline `<script>` at the bottom of admin.html
3. For complex logic, add methods to `ImportTool` in `js/import-tool.js`
4. Use `SourceRegistry` events for reactive updates to the UI

---

## Limitations & Known Issues

1. **Client-Side Scraping**: Browser-based extraction is inherently limited by CORS. The 3-strategy proxy fallback helps but is not guaranteed to work for all sites.

2. **Dynamic Content**: Sites that load images via JavaScript (lazy loading, infinite scroll) may not have image URLs in the initial HTML response. The `extractImageUrls()` method checks `data-src` and `data-lazy-src` attributes for lazy-loaded images, but more sophisticated loading patterns may fail.

3. **Site Structure Changes**: If a target site changes its HTML structure, the CSS selectors in the source plugin will break. Regular maintenance of source plugins is required.

4. **Rate Limiting**: The default 1-second rate limit is conservative. For high-volume bulk imports, consider increasing it or implementing exponential backoff.

5. **No Server-Side Extraction**: Currently all extraction happens client-side. A more robust approach would use a server-side scraping service (e.g., Puppeteer, Cheerio) that can handle JavaScript-rendered pages and bypass CORS entirely.

---

## Future Improvements

1. **Server-Side Proxy**: Move extraction to a Cloud Function or server that can fetch and parse pages server-side, eliminating CORS issues entirely.

2. **Headless Browser Support**: Use Puppeteer or Playwright in a Cloud Function to handle JavaScript-heavy sites with dynamic content loading.

3. **Source Plugin Marketplace**: Allow community-contributed source plugins that can be loaded dynamically without code changes.

4. **Extraction Caching**: Cache extracted data in Firestore to avoid re-extracting the same URL multiple times.

5. **Diff-Based Updates**: When updating an existing chapter, compare image URLs and only update if they've changed.

6. **Scheduled Imports**: Automatically check for new chapters on a schedule (using Cloud Scheduler + Cloud Functions).

7. **Webhook Support**: Allow source sites to notify the platform of new chapters via webhooks, eliminating the need for scraping.

8. **Improved Error Recovery**: For bulk import, implement retry logic with exponential backoff for transient failures.
