# slack-tools

## unreplied-checker

A CLI tool that finds Slack mentions you haven't responded to yet. It searches for messages that mention a specific user and checks whether the user has replied in the thread or reacted to the message.

### Prerequisites

Set the `SLACK_USER_TOKEN` environment variable with a Slack user token that has the following scopes:

- `search:read`
- `channels:history`
- `reactions:read`

### Usage

```bash
npm run unreplied-checker -- --user-id <SLACK_USER_ID> [options]
```

### Options

| Option | Required | Default | Description |
|---|---|---|---|
| `--user-id` | Yes | — | Slack user ID to check mentions for |
| `--days` | No | `3` | Number of days to look back |
| `--channels` | No | all | Comma-separated channel names to filter (e.g. `general,engineering`) |
| `--limit` | No | `20` | Maximum number of mentions to retrieve |

### Example

```bash
export SLACK_USER_TOKEN=xoxp-...
npm run unreplied-checker -- --user-id U01ABCDEF --days 7 --channels general,random
```
