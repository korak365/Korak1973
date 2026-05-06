// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log, KeyValueStore } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset } from 'crawlee';

await Actor.init();

// ─── Input ────────────────────────────────────────────────────────────────────
const {
    retailers = ['walmart', 'kroger', 'target'],
    categories = ['dairy', 'bread', 'meat', 'produce', 'beverages'],
    startUrls = [],
    trackPriceHistory = true,
    minPriceChangePct = 5,
    maxRequestsPerCrawl = 300,
    maxProductsPerCategory = 40,
    zipCode = '10001',
    proxyConfiguration: proxyConfig,
} = (await Actor.getInput()) ?? {};

log.info('Starting Grocery Price Index scraper', {
    retailers,
    categories,
    trackPriceHistory,
    zipCode,
});

// ─── Proxy ────────────────────────────────────────────────────────────────────
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

// ─── Price history key-value store ────────────────────────────────────────────
const HISTORY_KEY = 'PRICE_HISTORY';
const store = await KeyValueStore.open();
let priceHistory = {};

if (trackPriceHistory) {
    const stored = await store.getValue(HISTORY_KEY);
    priceHistory = stored ?? {};
    log.info(`Loaded price history with ${Object.keys(priceHistory).length} entries`);
}

// ─── Retailer URL map ─────────────────────────────────────────────────────────
// Maps retailer + category → search/browse URL
const RETAILER_URLS = {
    walmart: {
        dairy:      'https://www.walmart.com/browse/food/dairy-eggs/976759_976779',
        bread:      'https://www.walmart.com/browse/food/bread/976759_976778_9948621',
        meat:       'https://www.walmart.com/browse/food/fresh-meat/976759_976779_8865263',
        produce:    'https://www.walmart.com/browse/food/fresh-produce/976759_976779_9348651',
        beverages:  'https://www.walmart.com/browse/food/beverages/976759_976799',
        snacks:     'https://www.walmart.com/browse/food/snacks-cookies-chips/976759_976790',
        frozen:     'https://www.walmart.com/browse/food/frozen-foods/976759_976783',
        canned:     'https://www.walmart.com/browse/food/canned-goods-soups/976759_976780',
    },
    kroger: {
        dairy:      'https://www.kroger.com/pl/dairy-eggs/05',
        bread:      'https://www.kroger.com/pl/bread-bakery/10',
        meat:       'https://www.kroger.com/pl/meat-seafood/06',
        produce:    'https://www.kroger.com/pl/produce/04',
        beverages:  'https://www.kroger.com/pl/beverages/51',
        snacks:     'https://www.kroger.com/pl/snacks/56',
        frozen:     'https://www.kroger.com/pl/frozen/31',
        canned:     'https://www.kroger.com/pl/canned-goods-soups/15',
    },
    target: {
        dairy:      'https://www.target.com/c/dairy-eggs-target-grocery/-/N-5xsyn',
        bread:      'https://www.target.com/c/bread-bakery-grocery-target/-/N-5xsym',
        meat:       'https://www.target.com/c/meat-seafood-target-grocery/-/N-5xsyl',
        produce:    'https://www.target.com/c/fresh-produce-target-grocery/-/N-5xszg',
        beverages:  'https://www.target.com/c/beverages-target-grocery/-/N-5xsz3',
        snacks:     'https://www.target.com/c/chips-pretzels-snacks-target-grocery/-/N-5xsz8',
        frozen:     'https://www.target.com/c/frozen-foods-target-grocery/-/N-5xsyd',
        canned:     'https://www.target.com/c/canned-goods-pantry-target-grocery/-/N-5xsye',
    },
    wholefoods: {
        dairy:      'https://www.wholefoodsmarket.com/products/dairy-eggs',
        bread:      'https://www.wholefoodsmarket.com/products/bread-baked-goods',
        meat:       'https://www.wholefoodsmarket.com/products/meat-poultry',
        produce:    'https://www.wholefoodsmarket.com/products/produce',
        beverages:  'https://www.wholefoodsmarket.com/products/beverages',
        snacks:     'https://www.wholefoodsmarket.com/products/snacks-chips-crackers',
        frozen:     'https://www.wholefoodsmarket.com/products/frozen-foods',
        canned:     'https://www.wholefoodsmarket.com/products/canned-goods',
    },
    aldi: {
        dairy:      'https://www.aldi.us/en/grocery-items/dairy-eggs/',
        bread:      'https://www.aldi.us/en/grocery-items/bread-bakery/',
        meat:       'https://www.aldi.us/en/grocery-items/meat-poultry-seafood/',
        produce:    'https://www.aldi.us/en/grocery-items/fresh-produce/',
        beverages:  'https://www.aldi.us/en/grocery-items/beverages/',
        snacks:     'https://www.aldi.us/en/grocery-items/snacks/',
        frozen:     'https://www.aldi.us/en/grocery-items/frozen-foods/',
        canned:     'https://www.aldi.us/en/grocery-items/canned-goods/',
    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parsePrice(str = '') {
    if (!str) return null;
    const match = str.replace(/,/g, '').match(/\d+\.?\d*/);
    return match ? Math.round(parseFloat(match[0]) * 100) / 100 : null;
}

function parsePricePerUnit(str = '') {
    // e.g. "$0.23/oz" → { price: 0.23, unit: "oz" }
    if (!str) return { pricePerUnit: null, unit: null };
    const match = str.match(/([\d.]+)\s*\/\s*(\w+)/);
    if (match) {
        return {
            pricePerUnit: Math.round(parseFloat(match[1]) * 1000) / 1000,
            unit: match[2],
        };
    }
    return { pricePerUnit: null, unit: null };
}

function makeHistoryKey(retailer, productName) {
    return `${retailer}::${productName.toLowerCase().trim()}`;
}

function calcPriceChange(current, previous) {
    if (!previous || !current) return { abs: null, pct: null };
    const abs = Math.round((current - previous) * 100) / 100;
    const pct = Math.round(((current - previous) / previous) * 10000) / 100;
    return { abs, pct };
}

// ─── Per-retailer parsers ─────────────────────────────────────────────────────

function parseWalmart($, retailer, category) {
    const products = [];
    // Walmart product tiles
    $('[data-item-id], [data-product-id], .sans-serif.mid-gray').each((_, el) => {
        const $el = $(el);
        const productName =
            $el.find('[data-automation-id="product-title"], .f6, .b, [class*="product-title"]').first().text().trim()
            || $el.find('span[data-automation-id="product-price"] + span').text().trim();
        const priceText =
            $el.find('[data-automation-id="product-price"], [itemprop="price"], .b.black.f1').first().text().trim();
        const perUnitText =
            $el.find('[data-automation-id="unit-price"], .f7').first().text().trim();
        const brand =
            $el.find('[data-automation-id="product-brand"]').first().text().trim() || null;
        const imageUrl =
            $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || null;
        const linkHref = $el.find('a').first().attr('href') || '';
        const productUrl = linkHref.startsWith('http')
            ? linkHref
            : linkHref ? `https://www.walmart.com${linkHref}` : null;

        if (!productName || productName.length < 3) return;

        const price = parsePrice(priceText);
        const { pricePerUnit, unit } = parsePricePerUnit(perUnitText);

        products.push({ retailer, category, productName, brand, price, pricePerUnit, unit, imageUrl, url: productUrl });
    });
    return products;
}

function parseKroger($, retailer, category) {
    const products = [];
    $('.ProductCard, .kds-Card, [data-testid="product-card"], article[class*="ProductCard"]').each((_, el) => {
        const $el = $(el);
        const productName =
            $el.find('.ProductCard-title, [data-testid="product-title"], h2, h3').first().text().trim();
        const priceText =
            $el.find('.ProductCard-price, [data-testid="cart-price"], .kds-Price').first().text().trim();
        const perUnitText =
            $el.find('.ProductCard-sellBy, .kds-Price--per-unit').first().text().trim();
        const brand =
            $el.find('.ProductCard-brand, [data-testid="product-brand"]').first().text().trim() || null;
        const imageUrl =
            $el.find('img').first().attr('src') || null;
        const linkHref = $el.find('a').first().attr('href') || '';
        const productUrl = linkHref.startsWith('http')
            ? linkHref
            : linkHref ? `https://www.kroger.com${linkHref}` : null;

        if (!productName || productName.length < 3) return;

        const price = parsePrice(priceText);
        const { pricePerUnit, unit } = parsePricePerUnit(perUnitText);

        products.push({ retailer, category, productName, brand, price, pricePerUnit, unit, imageUrl, url: productUrl });
    });
    return products;
}

function parseTarget($, retailer, category) {
    const products = [];
    $('[data-test="product-details"], [data-test="@web/site-top-of-funnel/ProductCardWrapper"]').each((_, el) => {
        const $el = $(el);
        const productName =
            $el.find('[data-test="product-title"], a[data-test="product-title"]').first().text().trim();
        const priceText =
            $el.find('[data-test="current-price"], [data-test="product-price"]').first().text().trim();
        const brand =
            $el.find('[data-test="product-brand"]').first().text().trim() || null;
        const imageUrl =
            $el.find('img').first().attr('src') || null;
        const linkHref = $el.find('a').first().attr('href') || '';
        const productUrl = linkHref.startsWith('http')
            ? linkHref
            : linkHref ? `https://www.target.com${linkHref}` : null;

        if (!productName || productName.length < 3) return;

        const price = parsePrice(priceText);

        products.push({ retailer, category, productName, brand, price, pricePerUnit: null, unit: null, imageUrl, url: productUrl });
    });
    return products;
}

function parseGeneric($, retailer, category, baseUrl) {
    // Generic fallback for Whole Foods, ALDI, and unknown retailers
    const products = [];
    const domain = new URL(baseUrl).origin;

    $('[class*="product"], [class*="item"], article, li[class*="grid"]').each((_, el) => {
        const $el = $(el);
        const productName =
            $el.find('h2, h3, h4, [class*="title"], [class*="name"]').first().text().trim();
        const priceText =
            $el.find('[class*="price"], [class*="cost"], [itemprop="price"]').first().text().trim();
        const brand =
            $el.find('[class*="brand"]').first().text().trim() || null;
        const imageUrl =
            $el.find('img').first().attr('src')
            || $el.find('img').first().attr('data-src')
            || null;
        const linkHref = $el.find('a').first().attr('href') || '';
        const productUrl = linkHref.startsWith('http')
            ? linkHref
            : linkHref ? `${domain}${linkHref}` : null;

        if (!productName || productName.length < 3) return;

        const price = parsePrice(priceText);
        products.push({ retailer, category, productName, brand, price, pricePerUnit: null, unit: null, imageUrl, url: productUrl });
    });
    return products;
}

// ─── Dispatch parser by retailer ─────────────────────────────────────────────
function parseProducts($, retailer, category, requestUrl) {
    switch (retailer) {
        case 'walmart':    return parseWalmart($, retailer, category);
        case 'kroger':     return parseKroger($, retailer, category);
        case 'target':     return parseTarget($, retailer, category);
        default:           return parseGeneric($, retailer, category, requestUrl);
    }
}

// ─── Enrich with price history ────────────────────────────────────────────────
function enrichWithHistory(product) {
    const key = makeHistoryKey(product.retailer, product.productName);
    const previous = priceHistory[key] ?? null;
    const { abs: priceChangeAbs, pct: priceChangePct } = calcPriceChange(product.price, previous);
    const inflationFlag = priceChangePct !== null && Math.abs(priceChangePct) >= minPriceChangePct;

    return {
        ...product,
        previousPrice: previous,
        priceChangeAbs,
        priceChangePct,
        inflationFlag,
    };
}

// ─── Build category index rows ────────────────────────────────────────────────
function buildCategoryIndexRows(allProducts) {
    const grouped = {};
    for (const p of allProducts) {
        const key = `${p.retailer}::${p.category}`;
        if (!grouped[key]) grouped[key] = { retailer: p.retailer, category: p.category, prices: [] };
        if (p.price !== null) grouped[key].prices.push(p.price);
    }

    return Object.values(grouped).map(({ retailer, category, prices }) => {
        if (prices.length === 0) return null;
        const avg = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        return {
            retailer,
            category,
            avgPrice: avg,
            minPrice: min,
            maxPrice: max,
            productCount: prices.length,
            scrapedAt: new Date().toISOString(),
            recordType: 'categoryIndex',
        };
    }).filter(Boolean);
}

// ─── Build start request list ─────────────────────────────────────────────────
const requests = [];
const seenUrls = new Set();

// From retailer map
for (const retailer of retailers) {
    const retailerMap = RETAILER_URLS[retailer];
    if (!retailerMap) {
        log.warning(`Unknown retailer "${retailer}", skipping.`);
        continue;
    }
    for (const category of categories) {
        const url = retailerMap[category];
        if (!url) {
            log.debug(`No URL for ${retailer}/${category}, skipping.`);
            continue;
        }
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        requests.push({ url, userData: { retailer, category, page: 1 } });
    }
}

// From manual startUrls
for (const entry of startUrls) {
    const url = typeof entry === 'string' ? entry : entry.url;
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    requests.push({ url, userData: { retailer: 'custom', category: 'custom', page: 1 } });
}

if (requests.length === 0) {
    log.error('No valid requests to crawl. Check "retailers", "categories", or "startUrls" in input.');
    await Actor.exit();
}

// ─── Collected products (for category index at end) ───────────────────────────
const allProducts = [];
// Track counts per retailer+category for maxProductsPerCategory cap
const counts = {};

// ─── Crawler ──────────────────────────────────────────────────────────────────
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 60,

    async requestHandler({ request, $, log, crawler: c }) {
        const { retailer, category, page } = request.userData;
        const countKey = `${retailer}::${category}`;
        if (!counts[countKey]) counts[countKey] = 0;

        log.info(`Scraping ${retailer} / ${category} — page ${page}`, { url: request.url });

        const rawProducts = parseProducts($, retailer, category, request.url);
        log.info(`Found ${rawProducts.length} raw products`, { retailer, category, page });

        const now = new Date().toISOString();
        let saved = 0;

        for (const product of rawProducts) {
            if (counts[countKey] >= maxProductsPerCategory) break;

            const enriched = enrichWithHistory(product);
            const record = {
                ...enriched,
                inStock: enriched.price !== null,
                scrapedAt: now,
                zipCode,
                recordType: 'product',
            };

            await Dataset.pushData(record);
            allProducts.push(record);

            // Update price history
            if (record.price !== null) {
                const hKey = makeHistoryKey(retailer, product.productName);
                priceHistory[hKey] = record.price;
            }

            counts[countKey]++;
            saved++;
        }

        log.info(`Saved ${saved} products for ${retailer}/${category}`, { page });

        // Paginate if under cap and found products
        if (
            rawProducts.length > 0
            && counts[countKey] < maxProductsPerCategory
            && page < 5
            && retailer !== 'custom'
        ) {
            const nextPage = page + 1;
            const baseUrl = request.url.split('?')[0];
            const nextUrl = `${baseUrl}?page=${nextPage}&start=${(nextPage - 1) * 48}`;
            await c.addRequests([{ url: nextUrl, userData: { retailer, category, page: nextPage } }]);
        }
    },

    async failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url}`, { error: error.message });
    },
});

await crawler.run(requests);

// ─── Save price history back to KV store ─────────────────────────────────────
if (trackPriceHistory) {
    await store.setValue(HISTORY_KEY, priceHistory);
    log.info(`Saved price history with ${Object.keys(priceHistory).length} entries`);
}

// ─── Write category index rows ────────────────────────────────────────────────
const indexRows = buildCategoryIndexRows(allProducts);
for (const row of indexRows) {
    await Dataset.pushData(row);
}
log.info(`Wrote ${indexRows.length} category index rows`);

// ─── Summary ──────────────────────────────────────────────────────────────────
const flagged = allProducts.filter(p => p.inflationFlag).length;
log.info('✅ Grocery Price Index scrape complete!', {
    totalProducts: allProducts.length,
    flaggedPriceChanges: flagged,
    categoryIndexRows: indexRows.length,
    retailers,
    categories,
});

if (allProducts.length === 0) {
    log.warning(
        'No products were collected. Retailers may be blocking static HTTP scraping. ' +
        'Consider switching to PlaywrightCrawler for JavaScript-rendered pages, ' +
        'or provide direct startUrls to category pages.'
    );
}

await Actor.exit();
