import { describe, expect, it } from "vitest";
import { newMailPayload } from "../src/worker/push";

describe("APNs new-mail payload", () => {
  it("contains a privacy-bounded alert and a tappable mailbox target", () => {
    const payload = newMailPayload({
      id: "message-1",
      thread_id: "thread-1",
      identity_address: "owner@example.com",
      sender_name: "Sender\nInjected",
      sender_address: "sender@example.com",
      subject: "A useful subject",
    });
    expect(payload).toEqual({
      aps: { alert: { title: "Sender Injected", body: "A useful subject" }, sound: "default",
        "thread-id": "thread-1", "mutable-content": 0 },
      messageId: "message-1",
      identity: "owner@example.com",
      folder: "inbox",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(4_096);
  });
});
