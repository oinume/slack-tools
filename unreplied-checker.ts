import { WebClient } from "@slack/web-api";
import { parseArgs } from "node:util";

interface UnrepliedMessage {
  channel: string;
  channelName: string;
  user: string;
  username: string;
  text: string;
  timestamp: string;
  permalink: string;
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      "user-id": { type: "string" },
      days: { type: "string", default: "3" },
      channels: { type: "string" },
      limit: { type: "string", default: "20" },
    },
  });

  const userId = values["user-id"];
  if (!userId) {
    console.error("Error: --user-id is required");
    process.exit(1);
  }

  return {
    userId,
    days: parseInt(values.days ?? "3", 10),
    channels: values.channels?.split(",").map((c) => c.trim()),
    limit: parseInt(values.limit ?? "20", 10),
  };
}

function formatTimestamp(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}

function cleanSlackText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1") // <@U123|name> → @name
    .replace(/<@[A-Z0-9]+>/g, "@user") // <@U123> → @user
    .replace(/<!subteam\^[A-Z0-9]+\|?[^>]*>/g, "@team") // <!subteam^S123> → @team
    .replace(/<!subteam\^[A-Z0-9]+>/g, "@team")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2") // <url|label> → label
    .replace(/<(https?:\/\/[^>]+)>/g, "$1") // <url> → url
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function truncateText(text: string, maxLen = 120): string {
  const cleaned = cleanSlackText(text);
  const oneLine = cleaned.replace(/\n/g, " ");
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "..." : oneLine;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchMentions(
  client: WebClient,
  userId: string,
  days: number,
  channels: string[] | undefined,
  limit: number
) {
  const after = new Date();
  after.setDate(after.getDate() - days);
  const afterStr = `${after.getFullYear()}-${String(after.getMonth() + 1).padStart(2, "0")}-${String(after.getDate()).padStart(2, "0")}`;

  let query = `<@${userId}> after:${afterStr}`;
  if (channels && channels.length > 0) {
    const channelFilter = channels.map((c) => `in:${c}`).join(" ");
    query += ` ${channelFilter}`;
  }

  const result = await client.search.messages({
    query,
    sort: "timestamp",
    sort_dir: "desc",
    count: limit,
  });

  return result.messages?.matches ?? [];
}

async function hasUserRepliedInThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  mentionTs: string,
  userId: string
): Promise<boolean> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: 200,
  });

  const messages = result.messages ?? [];
  for (const msg of messages) {
    if (!msg.ts || !msg.user) continue;
    if (msg.user === userId && parseFloat(msg.ts) > parseFloat(mentionTs)) {
      return true;
    }
  }
  return false;
}

async function hasUserReacted(
  client: WebClient,
  channel: string,
  timestamp: string,
  userId: string
): Promise<boolean> {
  try {
    const result = await client.reactions.get({
      channel,
      timestamp,
      full: true,
    });
    const reactions = result.message?.reactions ?? [];
    return reactions.some((r) => r.users?.includes(userId));
  } catch {
    return false;
  }
}

async function main() {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) {
    console.error("Error: SLACK_USER_TOKEN environment variable is required");
    process.exit(1);
  }

  const args = parseCliArgs();
  const client = new WebClient(token);

  console.log(
    `Searching for unreplied mentions of ${args.userId} in the last ${args.days} day(s)...`
  );
  if (args.channels) {
    console.log(`Filtering channels: ${args.channels.join(", ")}`);
  }
  console.log();

  const matches = await searchMentions(
    client,
    args.userId,
    args.days,
    args.channels,
    args.limit
  );

  if (matches.length === 0) {
    console.log("No mentions found.");
    return;
  }

  console.log(`Found ${matches.length} mention(s). Checking responses...`);
  console.log();

  const unreplied: UnrepliedMessage[] = [];

  for (const match of matches) {
    const channel = match.channel?.id;
    const channelName = match.channel?.name ?? "unknown";
    const ts = match.ts;
    const user = match.user ?? "unknown";
    const username = match.username ?? "unknown";
    const text = match.text ?? "";
    const permalink = match.permalink ?? "";

    if (!channel || !ts) continue;

    // Skip messages sent by the target user themselves
    if (user === args.userId) continue;

    // Determine the thread timestamp
    // If the message is in a thread, permalink contains thread_ts parameter
    let threadTs = ts;
    if (permalink) {
      const threadTsMatch = permalink.match(/thread_ts=([\d.]+)/);
      if (threadTsMatch) {
        threadTs = threadTsMatch[1];
      }
    }

    // Check if user has replied in the thread
    const replied = await hasUserRepliedInThread(
      client,
      channel,
      threadTs,
      ts,
      args.userId
    );
    if (replied) {
      await sleep(200);
      continue;
    }

    // Check if user has reacted to the message
    const reacted = await hasUserReacted(client, channel, ts, args.userId);
    if (reacted) {
      await sleep(200);
      continue;
    }

    unreplied.push({
      channel,
      channelName,
      user,
      username,
      text,
      timestamp: ts,
      permalink,
    });

    // Rate limit: sleep between API calls
    await sleep(200);
  }

  if (unreplied.length === 0) {
    console.log("All mentions have been responded to!");
    return;
  }

  console.log(`=== 未対応メンション (${unreplied.length}件) ===`);
  console.log();

  unreplied.forEach((msg, i) => {
    console.log(
      `${i + 1}. #${msg.channelName} | ${msg.username} | ${formatTimestamp(msg.timestamp)}`
    );
    console.log(`   ${truncateText(msg.text)}`);
    console.log(`   ${msg.permalink}`);
    console.log();
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
