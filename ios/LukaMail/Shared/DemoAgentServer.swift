import Foundation

/// The demo server's agent: saved chats and streamed answers with proposed
/// emails, so the Agent tab works interactively in Demo Mode without a server.
enum DemoAgentServer {
    private static let me = "alex@example.com"

    static let samReply = AgentDraft(
        id: "demo-draft-sam", from: me, to: ["sam@example.com"], cc: [], subject: "Re: Server move this weekend",
        body: "Hi Sam,\n\nSaturday at 10 works for me. I'll bring the two new SSDs, so we can swap them right after the backup.\n\nBest,\nAlex",
        replyToMessageId: "plain", status: .draft)

    private static var chats: [AgentChatSummary] {
        [
            AgentChatSummary(id: "demo-chat-replies", title: "Replies waiting", identity: nil,
                             preview: "Here's a reply in your usual tone — edit anything, then tap Send.",
                             createdAt: iso(-0.4), updatedAt: iso(-0.2)),
            AgentChatSummary(id: "demo-chat-review", title: "Q4 Design Review", identity: nil,
                             preview: "The design review starts Monday at 9:00 AM in Room B 204.", createdAt: iso(-20), updatedAt: iso(-19)),
            AgentChatSummary(id: "demo-chat-billing", title: "Hosting invoices", identity: nil,
                             preview: "Three invoices this quarter, $184.20 in total.", createdAt: iso(-80), updatedAt: iso(-79)),
        ]
    }

    private static func iso(_ hours: Double) -> String { Date.now.addingTimeInterval(hours * 3_600).formatted(.iso8601) }

    private static func source(_ id: String, _ subject: String, _ from: String, read: Bool) -> AgentSource {
        AgentSource(id: id, subject: subject, from: from, receivedAt: iso(-2), identity: me, read: read)
    }

    private static var repliesChat: AgentChatDetail {
        let currentChats = chats
        return AgentChatDetail(chat: currentChats[0], messages: [
            AgentChatMessage(id: "m1", role: .user, content: "What needs my reply today?", createdAt: iso(-0.4)),
            AgentChatMessage(
                id: "m2", role: .assistant,
                content: """
                Two mails are waiting on you:

                1. **Jordan Lee** – *Re: Q4 Design Review*: the review starts **Monday at 9:00 AM**; Jordan asks you to confirm by Friday.
                2. **Sam Patel** – *Server move this weekend*: Sam will take the backup first and asks whether **Saturday 10:00** still works.

                Everything else today is newsletters and notifications.
                """,
                createdAt: iso(-0.4),
                activity: [AgentActivity(tool: "semantic_search", label: "Searched mail for “waiting for my reply”"),
                           AgentActivity(tool: "read_message", label: "Read a message"),
                           AgentActivity(tool: "read_message", label: "Read a message")],
                sources: [source("work-reply", "Re: Q4 Design Review", "Jordan Lee <jordan@example.org>", read: true),
                          source("plain", "Re: Server move this weekend", "Sam Patel <sam@example.com>", read: true),
                          source("newsletter", "Liquid Glass in Practice — Issue #212", "Swift Weekly <news@swiftweekly.example>", read: false)]),
            AgentChatMessage(id: "m3", role: .user, content: "Reply to Sam that Saturday works and I'll bring the new SSDs", createdAt: iso(-0.2)),
            AgentChatMessage(
                id: "m4", role: .assistant, content: "Here's a reply in your usual tone — edit anything, then tap **Send**.",
                createdAt: iso(-0.2),
                activity: [AgentActivity(tool: "style_examples", label: "Read your earlier mails to sam@example.com"),
                           AgentActivity(tool: "propose_email", label: "Wrote an email")],
                drafts: [samReply]),
        ])
    }

    static func respond(method: String, route: [String], body: Data?) -> DemoMailServer.Response {
        switch (method, route.count) {
        case ("GET", 2):
            return json(AgentChatList(chats: chats))
        case ("GET", 3):
            if route[2] == "demo-chat-replies" { return json(repliesChat) }
            guard let chat = chats.first(where: { $0.id == route[2] }) else { return DemoMailServer.Response(status: 404) }
            return json(AgentChatDetail(chat: chat, messages: [
                AgentChatMessage(id: "u", role: .user, content: chat.title, createdAt: chat.createdAt),
                AgentChatMessage(id: "a", role: .assistant, content: chat.preview, createdAt: chat.updatedAt),
            ]))
        case ("DELETE", 3):
            return json(["deleted": true])
        case ("PATCH", 5):
            var draft = samReply
            if let patch = body.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) {
                if let text = patch["body"] as? String { draft.body = text }
                if let subject = patch["subject"] as? String { draft.subject = subject }
                if let status = (patch["status"] as? String).flatMap(AgentDraft.Status.init(rawValue:)) { draft.status = status }
            }
            return json(["draft": draft])
        case ("POST", 6):
            var draft = samReply
            draft.status = .sent
            var response = json(DemoSent(sent: true, draft: draft))
            response.delay = 0.8
            return response
        case ("POST", 2):
            let prompt = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["text"] as? String) ?? ""
            return stream(for: prompt)
        default:
            return DemoMailServer.Response(status: 404)
        }
    }

    private struct DemoSent: Encodable { let sent: Bool; let draft: AgentDraft }

    private static func json<Value: Encodable>(_ value: Value) -> DemoMailServer.Response {
        DemoMailServer.Response(data: (try? JSONEncoder().encode(value)) ?? Data())
    }

    /// A believable turn: a search, a read, an answer streamed word by word, and an email when asked for one.
    private static func stream(for prompt: String) -> DemoMailServer.Response {
        let writes = prompt.range(of: #"(?i)\b(reply|write|answer|draft|shorter|formal|friendl|english)"#,
                                  options: .regularExpression) != nil
        var events: [[String: Any]] = [["type": "chat", "chatId": "demo-chat-new", "userMessageId": "u-new", "assistantMessageId": "a-new"]]
        events.append(["type": "tool-call", "tool": "semantic_search", "label": "Searched mail for “\(prompt.prefix(40))”"])
        events.append(["type": "sources", "messages": [
            ["id": "plain", "subject": "Re: Server move this weekend", "from": "Sam Patel <sam@example.com>",
             "receivedAt": iso(-5), "identity": me, "read": true]]])
        events.append(["type": "tool-call", "tool": "read_message", "label": "Read a message"])
        let answer: String
        if writes {
            events.append(["type": "tool-call", "tool": "propose_email", "label": "Wrote an email"])
            var draft = samReply
            draft.body = "Hi Sam,\n\nSaturday at 10 works. I'll bring the SSDs.\n\nBest,\nAlex"
            draft.revisesDraftId = nil
            if let data = try? JSONEncoder().encode(draft), let object = try? JSONSerialization.jsonObject(with: data) {
                events.append(["type": "draft", "draft": object])
            }
            answer = "Done — a shorter version is below. Tap **Send** when it looks right."
        } else {
            answer = "Sam asked whether **Saturday 10:00** still works for the server move. Sam will take the backup first, so the swap can start right after.\n\n- Backup: Sam, before 10:00\n- New SSDs: you bring them\n- Checklist: linked in the message"
        }
        for word in answer.split(separator: " ", omittingEmptySubsequences: false) {
            events.append(["type": "text", "text": "\(word) "])
        }
        events.append(["type": "finish", "toolCalls": writes ? 3 : 2])
        events.append(["type": "title", "chatId": "demo-chat-new", "title": writes ? "Reply to Sam" : "Server move"])
        let chunks = events.compactMap { event -> Data? in
            guard var line = try? JSONSerialization.data(withJSONObject: event) else { return nil }
            line.append(0x0A)
            return line
        }
        return DemoMailServer.Response(contentType: "application/x-ndjson", delay: 0.6, chunks: chunks, chunkInterval: 0.05)
    }
}
