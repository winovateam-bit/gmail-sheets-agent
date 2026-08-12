# Gmail to Google Sheets AI Agent

An automated, serverless agent built on Cloudflare Workers that extracts data from Gmail, analyzes and structures the email contents using Anthropic's Claude AI, and records processed records into Google Sheets on a recurring schedule.

## Features

- **Automated Cron Scheduling:** Executes automatically at specified intervals using Cloudflare Cron Triggers.
- **AI Email Processing:** Parses email content and metadata using the Anthropic Claude API to extract key structured data points.
- **Google Sheets Integration:** Appends extracted data into target spreadsheets dynamically.
- **State Management:** Uses Cloudflare KV storage to track processed email IDs and prevent duplicate processing.
- **Serverless Architecture:** Lightweight execution with zero persistent server maintenance costs.

## Tech Stack

- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/)
- **AI Engine:** [Anthropic Claude API](https://www.anthropic.com/)
- **Storage:** Cloudflare KV (Key-Value) Storage
- **Spreadsheet Integration:** Google Sheets API
- **Configuration & CLI:** Wrangler v3

## Environment Variables & Secrets

| Variable / Secret Name | Type | Description |
|---|---|---|
| `GOOGLE_SHEET_ID` | `var` | Target Google Sheets ID defined in `wrangler.jsonc` |
| `AGENT_KV` | `kv_namespace` | Cloudflare KV Namespace for tracking processed state |
| `ANTHROPIC_API_KEY` | `secret` | Encrypted Anthropic API key stored via Wrangler secrets |

## Local Development & Setup

1. **Clone repository:**
   ```bash
   git clone https://github.com/winovateam-bit/gmail-sheets-agent.git
   cd gmail-sheets-agent
