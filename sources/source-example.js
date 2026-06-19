/**
 * ============================================================
 * MANHWA PLATFORM - EXAMPLE SOURCE PLUGIN
 * ============================================================
 * 
 * This is an example source plugin demonstrating how to
 * create a working source for a fictional manhwa website.
 * 
 * Use this as a reference when creating plugins for real sites.
 * 
 * IMPORTANT NOTES:
 * - Most real sites have CORS protection, making direct
 *   browser fetching impossible. This plugin system is
 *   designed to work when CORS allows or via proxy.
 * - Sites often change their HTML structure, requiring
 *   plugin updates.
 * - Respect robots.txt and terms of service.
 * - This is for educational purposes only.
 * 
 * ============================================================
 */

/**
 * Example Webtoon Source
 * Demonstrates a working source plugin for reference
 */
const SourceExample = {
  name: 'Example Webtoon Site',
  domain: 'webtoon.example',
  
  patterns: [
    /webtoon\.example\/series\/\d+\/chapter-\d+/,
    /webtoon\.example\/read\/\d+\/\d+/
  ],

  detect(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.includes(this.domain) &&
             this.patterns.some(pattern => pattern.test(url));
    } catch {
      return false;
    }
  },

  async extract(url) {
    try {
      const html = await window.SourceConfig.fetchPage(url, {
        validator: (pageHtml) => /<img|images|chapter|episode|reader/i.test(pageHtml)
      });
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const chapterData = {
        chapterTitle: this.extractTitle(doc),
        chapterNumber: this.extractChapterNumber(doc, url),
        imageUrls: this.extractImageUrls(doc),
        seriesTitle: this.extractSeriesTitle(doc),
        source: this.name,
        sourceUrl: url
      };

      if (!this.validate(chapterData)) {
        throw new Error('Could not extract valid chapter data. The site structure may have changed.');
      }

      return chapterData;

    } catch (error) {
      throw error;
    }
  },

  extractTitle(doc) {
    // Try multiple possible selectors
    const selectors = [
      '.chapter-header h1',
      '.episode-title',
      '[property="og:title"]',
      'h1.reading-title',
      '.title h2'
    ];

    for (const selector of selectors) {
      if (selector.startsWith('[property=')) {
        const meta = doc.querySelector(selector);
        if (meta?.content) return meta.content.trim();
      } else {
        const el = doc.querySelector(selector);
        if (el?.textContent?.trim()) {
          return el.textContent.trim()
            .replace(/\s+/g, ' ')
            .substring(0, 200);
        }
      }
    }

    return null;
  },

  extractChapterNumber(doc, url) {
    // Extract from URL pattern first
    const patterns = [
      /chapter[_-]?(\d+(?:\.\d+)?)/i,
      /\/ch[_-]?(\d+(?:\.\d+)?)/i,
      /\/ep[_-]?(\d+(?:\.\d+)?)/i,
      /\/(\d+(?:\.\d+)?)(?:\/|$)/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return parseFloat(match[1]);
    }

    // Try DOM selectors
    const selectors = [
      '.chapter-number',
      '.episode-number',
      '[data-chapter-num]',
      '.chap-num span'
    ];

    for (const selector of selectors) {
      const el = doc.querySelector(selector);
      if (el?.textContent) {
        const match = el.textContent.match(/(\d+(?:\.\d+)?)/);
        if (match) return parseFloat(match[1]);
      }
    }

    return null;
  },

  extractImageUrls(doc) {
    const images = [];
    
    // Look for image containers
    const containers = [
      '.viewer-images',
      '.episode-images',
      '.manga-container',
      '.reader-content',
      '#image-container',
      '.img-list'
    ];

    for (const containerSelector of containers) {
      const container = doc.querySelector(containerSelector);
      if (!container) continue;

      const imgs = container.querySelectorAll('img');
      imgs.forEach(img => {
        // Check multiple possible image source attributes
        const src = img.dataset.src || 
                     img.dataset.lazySrc || 
                     img.dataset.original || 
                     img.dataset.cdn || 
                     img.src;

        if (src && this.isValidImageUrl(src)) {
          images.push(src);
        }
      });

      if (images.length > 0) break;
    }

    // Fallback: Look for data attributes in script tags (JSON data)
    if (images.length === 0) {
      const scripts = doc.querySelectorAll('script:not([src])');
      scripts.forEach(script => {
        const text = script.textContent;
        
        // Look for JSON image arrays
        const jsonMatches = text.match(/['"]images['"]\s*:\s*(\[[^\]]+\])/);
        if (jsonMatches) {
          try {
            const parsed = JSON.parse(jsonMatches[1].replace(/'/g, '"'));
            parsed.forEach(url => {
              if (typeof url === 'string' && this.isValidImageUrl(url)) {
                images.push(url);
              }
            });
          } catch (e) {
            // JSON parse failed, try regex
            const urlMatches = jsonMatches[1].match(/https?:\/\/[^"'\s]+/g);
            if (urlMatches) {
              urlMatches.forEach(url => {
                if (this.isValidImageUrl(url)) images.push(url);
              });
            }
          }
        }
      });
    }

    return [...new Set(images)]; // Remove duplicates
  },

  extractSeriesTitle(doc) {
    const selectors = [
      '.series-title h1',
      '.manga-title',
      '[property="og:series"]',
      '.title a',
      'h1.series-name'
    ];

    for (const selector of selectors) {
      if (selector.startsWith('[property=')) {
        const meta = doc.querySelector(selector);
        if (meta?.content) return meta.content.trim();
      } else {
        const el = doc.querySelector(selector);
        if (el?.textContent?.trim()) {
          return el.textContent.trim().substring(0, 200);
        }
      }
    }

    return null;
  },

  isValidImageUrl(url) {
    if (!url || url.startsWith('data:')) return false;
    if (url.includes('placeholder') || url.includes('spacer')) return false;
    if (url.includes('logo') || url.includes('icon') || url.includes('avatar')) return false;
    return /\.(jpg|jpeg|png|webp|gif|bmp)(\?.*)?$/i.test(url) || 
           url.includes('cdn') || 
           url.includes('image');
  },

  validate(data) {
    if (!data.imageUrls || data.imageUrls.length === 0) {
      console.error(`[${this.name}] No images extracted`);
      return false;
    }

    if (!data.chapterNumber && data.chapterNumber !== 0) {
      console.warn(`[${this.name}] No chapter number found, using default`);
      data.chapterNumber = 1;
    }

    if (!data.chapterTitle) {
      data.chapterTitle = `Chapter ${data.chapterNumber}`;
    }

    return true;
  }
};

// Export the source
window.SourceExample = SourceExample;
