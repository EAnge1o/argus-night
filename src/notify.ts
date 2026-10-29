import type { ArgusConfig } from "./config.js";
import type { Logger } from "./log.js";

/**
 * Fire-and-forget webhook notifications. Formats: Slack {text},
 * Discord {content}, 飞书/Lark {msg_type, content.text}, raw (whole event).
 */
export class Notifier {
  constructor(
    private cfg: ArgusConfig,
    private log: Logger,
  ) {}

  send(event: string, title: string, body: string): void {
    const n = this.cfg.notify;
    if (!n.webhookUrl) return;
    if (!n.events.includes(event)) return;
    const payload = this.format(title + "\n" + body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    fetch(n.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) this.log.debug(`通知发送失败: HTTP ${res.status}`);
      })
      .catch((e) => this.log.debug(`通知发送异常: ${e}`))
      .finally(() => clearTimeout(timer));
  }

  private format(text: string): Record<string, unknown> {
    switch (this.cfg.notify.format) {
      case "discord":
        return { content: text };
      case "lark":
        return { msg_type: "text", content: { text } };
      case "raw":
        return { event: text, text };
      case "slack":
      default:
        return { text };
    }
  }
}
