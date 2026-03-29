# sec-iapd (OpenClaw plugin)

SEC IAPD adapter plugin for the standalone `enrichment` core.

## Dependency

Install and enable `enrichment` first.

## Install

```bash
openclaw plugins install enrichment
openclaw plugins enable enrichment
openclaw plugins install sec-iapd
openclaw plugins enable sec-iapd
openclaw gateway restart
```

## Usage

```bash
npm run import -- --state NE --limit 100
```

Cron-friendly:

```bash
npm run import -- --state NE --limit 100 --quiet
```

Summary is emitted as JSON on stdout for monitoring and automation.
