## Architecture

```
Azure AI──▶ mcp-remote ──HTTP──▶ serviceNow-mcp ──REST──▶ ServiceNow
```
## Quick start for local run

```bash
# 1. Install dependencies
npm install

# 3. Run the gateway
npm run dev          # tsx watch — hot reload on file changes
# or
npm run build && npm start
```
