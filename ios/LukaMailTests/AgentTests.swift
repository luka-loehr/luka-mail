import Foundation
import Testing
@testable import LukaMail

struct AgentTests {
    @Test
    func decodesTheAgentStream() throws {
        let chat = AgentStreamEvent.decode(#"{"type":"chat","chatId":"c1","userMessageId":"u1","assistantMessageId":"a1"}"#)
        guard case .chat("c1", "u1", "a1") = chat else { Issue.record("expected the chat ids, got \(String(describing: chat))"); return }

        let call = AgentStreamEvent.decode(#"{"type":"tool-call","tool":"semantic_search","input":{"query":"x"},"label":"Searched mail for “x”"}"#)
        guard case .toolCall(let activity) = call else { Issue.record("expected a tool call"); return }
        #expect(activity == AgentActivity(tool: "semantic_search", label: "Searched mail for “x”"))

        let draftLine = #"{"type":"draft","draft":{"id":"d1","from":"alex@example.com","to":["sam@example.com"],"cc":[],"subject":"Re: Hi","#
            + #""body":"Hi Sam","replyToMessageId":"m1","revisesDraftId":"d0","status":"draft"}}"#
        guard case .draft(let draft) = AgentStreamEvent.decode(draftLine) else { Issue.record("expected a draft"); return }
        #expect(draft.to == ["sam@example.com"])
        #expect(draft.revisesDraftId == "d0")
        #expect(draft.isEditable)

        let sources = AgentStreamEvent.decode(#"{"type":"sources","messages":[{"id":"m1","subject":"Hi","from":"Sam Patel <sam@example.com>","receivedAt":"2026-10-23T08:00:00Z","identity":null,"read":true}]}"#)
        guard case .sources(let messages) = sources else { Issue.record("expected sources"); return }
        #expect(messages.first?.senderName == "Sam Patel")
        #expect(messages.first?.senderAddress == "sam@example.com")

        guard case .text("Hello") = AgentStreamEvent.decode(#"{"type":"text","text":"Hello"}"#) else { Issue.record("expected text"); return }
        guard case .other = AgentStreamEvent.decode(#"{"type":"heartbeat","elapsedSeconds":4}"#) else { Issue.record("expected other"); return }
        #expect(AgentStreamEvent.decode("not json") == nil)
    }

    @Test
    func readsSavedChatsWithISODates() throws {
        let json = #"{"chats":[{"id":"c1","title":"Reply to Sam","identity":null,"preview":"Draft.","createdAt":"2026-10-23T09:41:07Z","updatedAt":"2026-10-23T09:41:07Z"}]}"#
        let list = try JSONDecoder().decode(AgentChatList.self, from: Data(json.utf8))
        #expect(list.chats.first?.updatedDate != nil)
    }
}

#if os(iOS)
struct MarkdownTests {
    @Test
    func parsesTheBlocksTheAgentWrites() {
        let blocks = MarkdownBlock.parse("""
        **Today** 3 messages arrived:

        1. First
        2. Second
          - Subitem

        | Date | Sender |
        |---|---|
        | 10/13 | Jordan Lee |

        > Quote
        ```
        code
        ```
        ## Summary
        """)
        #expect(blocks == [
            .paragraph("**Today** 3 messages arrived:"),
            .list([.init(marker: "1.", text: "First", indent: 0), .init(marker: "2.", text: "Second", indent: 0),
                   .init(marker: "•", text: "Subitem", indent: 1)]),
            .table(["Date", "Sender"], [["10/13", "Jordan Lee"]]),
            .quote("Quote"),
            .code("code"),
            .heading(2, "Summary"),
        ])
    }
}
#endif

extension AgentStreamEvent: @retroactive Equatable {
    public static func == (lhs: AgentStreamEvent, rhs: AgentStreamEvent) -> Bool { String(describing: lhs) == String(describing: rhs) }
}
