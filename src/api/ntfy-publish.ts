export type NtfyPublishInput = {
  server: string;
  topic: string;
  body: string;
  title: string;
  priority?: string;
  tags?: string;
  user?: string;
  password?: string;
};

export async function publishNtfy(input: NtfyPublishInput): Promise<void> {
  const server = input.server.replace(/\/+$/, "");
  const topic = input.topic.replace(/^\/+/, "");
  const headers: Record<string, string> = {
    Title: input.title,
    Priority: input.priority ?? "4",
    Tags: input.tags ?? "warning,copyright",
  };

  const auth =
    input.user && input.password
      ? `${input.user}:${input.password}`
      : undefined;

  const response = await fetch(`${server}/${topic}`, {
    method: "POST",
    headers: auth
      ? { ...headers, Authorization: `Basic ${btoa(auth)}` }
      : headers,
    body: input.body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ntfy publish failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
}
