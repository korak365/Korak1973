## What are Apify Actors?

- Actors are serverless cloud programs that can perform anything from a simple action, like filling out a web form, to a complex operation, like crawling an entire website or removing duplicates from a large dataset.
- Actors are programs packaged as Docker images, which accept a well-defined JSON input, perform an action, and optionally produce a well-defined JSON output.

### Apify Actor directory structure

```text
.actor/
├── actor.json            # Actor config: name, version, env vars, runtime settings
├── input_schema.json     # Input validation & Console form definition
├── dataset_schema.json   # Dataset schema definition
└── output_schema.json    # Specifies where an Actor stores its output
src/
└── main.js               # Actor entry point and orchestrator
storage/                  # Local storage (mirrors Cloud during development)
├── datasets/             # Output items (JSON objects)
├── key_value_stores/     # Files, config, INPUT — price history is stored here
└── request_queues/       # Pending crawl requests
Dockerfile                # Container image definition
AGENTS.md                 # AI agent instructions (this file)
```

## Apify CLI

### Installation

- Install Apify CLI only if it is not already installed.
- If Apify CLI is not installed, install it using the following commands:
  - macOS/Linux: `curl -fsSL https://apify.com/install-cli.sh | bash`
  - Windows: `irm https://apify.com/install-cli.ps1 | iex`

### Apify CLI Commands

```bash
# Local development
apify run                              # Run Actor locally

# Authentication & deployment
apify login                            # Authenticate account
apify push                             # Deploy to Apify platform

# Help
apify help                             # List all commands
```

## Actor-specific notes

- Price history is persisted in the **Key-Value Store** under the key `PRICE_HISTORY` as a JSON object mapping `retailer::productName` → last known price.
- On each run, products are compared against the stored history. Items that changed by ≥ `minPriceChangePct`% are flagged with `inflationFlag: true`.
- Category index rows (`recordType: "categoryIndex"`) are written to the same dataset as product rows and can be filtered server-side using the `categoryIndex` view.
- Major retailers (Walmart, Target, Kroger) render most product listings via JavaScript. If scrapes return 0 results, upgrade `CheerioCrawler` to `PlaywrightCrawler` in `src/main.js`.

## Do

- use Apify CLI to run the Actor locally, and push it to the Apify platform
- use `KeyValueStore` to persist price history between runs for inflation tracking
- use `CheerioCrawler` for initial attempts (fast); fall back to `PlaywrightCrawler` for JS-heavy pages
- validate input early and fail gracefully with descriptive error messages
- use rotating proxies — major grocery retailers aggressively block datacenter IPs
- cap concurrency at 3–5 to avoid rate limiting from grocery sites
- respect robots.txt and retailer Terms of Service

## Don't

- do not hard-code retailer URLs — keep them in the `RETAILER_URLS` map in `main.js`
- do not skip price history persistence — it is the core inflation-tracking feature
- do not use `additionalHttpHeaders` — use `preNavigationHooks` instead
- do not exceed 5 pages of pagination per category to avoid overloading retailer servers

## Resources

- [docs.apify.com/llms.txt](https://docs.apify.com/llms.txt) - Quick reference
- [crawlee.dev](https://crawlee.dev) - Crawlee documentation
- [docs.apify.com/sdk/js](https://docs.apify.com/sdk/js) - Apify JS SDK docs
